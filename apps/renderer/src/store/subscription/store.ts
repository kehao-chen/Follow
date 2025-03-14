import { produce } from "immer"
import { omit } from "lodash-es"
import { parse } from "tldts"

import { whoami } from "~/atoms/user"
import { runTransactionInScope } from "~/database"
import { apiClient } from "~/lib/api-fetch"
import { FeedViewType } from "~/lib/enum"
import { capitalizeFirstLetter } from "~/lib/utils"
import type { SubscriptionModel } from "~/models"
import { SubscriptionService } from "~/services"

import { entryActions } from "../entry"
import { feedActions, getFeedById } from "../feed"
import { feedUnreadActions } from "../unread"
import { createZustandStore, doMutationAndTransaction } from "../utils/helper"

export type SubscriptionFlatModel = Omit<SubscriptionModel, "feeds"> & {
  defaultCategory?: string
}
interface SubscriptionState {
  /**
   * Key: feedId
   * Value: SubscriptionPlainModel
   */
  data: Record<FeedId, SubscriptionFlatModel>
  /**
   * Key: FeedViewType
   * Value: FeedId[]
   */
  feedIdByView: Record<FeedViewType, FeedId[]>
}

function morphResponseData(data: SubscriptionModel[]): SubscriptionFlatModel[] {
  const result: SubscriptionFlatModel[] = []
  for (const subscription of data) {
    const cloned: SubscriptionFlatModel = { ...subscription }
    if (!subscription.category && subscription.feeds) {
      const { siteUrl } = subscription.feeds
      if (!siteUrl) {
        cloned.defaultCategory = subscription.feedId
      } else {
        const parsed = parse(siteUrl)

        if (parsed.domain) {
          cloned.defaultCategory = capitalizeFirstLetter(parsed.domain)
        } else {
          cloned.defaultCategory = subscription.feedId
        }
      }
    }
    result.push(cloned)
  }
  return result
}

const emptyDataIdByView: Record<FeedViewType, FeedId[]> = {
  [FeedViewType.Articles]: [],
  [FeedViewType.Audios]: [],
  [FeedViewType.Notifications]: [],
  [FeedViewType.Pictures]: [],
  [FeedViewType.SocialMedia]: [],
  [FeedViewType.Videos]: [],
}

export const useSubscriptionStore = createZustandStore<SubscriptionState>("subscription")(() => ({
  data: {},
  feedIdByView: { ...emptyDataIdByView },
}))

const set = useSubscriptionStore.setState
const get = useSubscriptionStore.getState

type MarkReadFilter = {
  startTime: number
  endTime: number
}

class SubscriptionActions {
  async fetchByView(view?: FeedViewType) {
    const res = await apiClient.subscriptions.$get({
      query: {
        view: view !== undefined ? String(view) : undefined,
      },
    })

    // reset dataIdByView
    if (view !== undefined) {
      set((state) => ({
        ...state,
        feedIdByView: { ...state.feedIdByView, [view]: [] },
      }))
    } else {
      set((state) => ({
        ...state,
        feedIdByView: { ...emptyDataIdByView },
      }))
    }

    const transformedData = morphResponseData(res.data)
    this.upsertMany(transformedData)
    feedActions.upsertMany(res.data.map((s) => s.feeds))

    return res.data
  }

  upsertMany(subscriptions: SubscriptionFlatModel[]) {
    runTransactionInScope(() => {
      SubscriptionService.upsertMany(subscriptions)
    })
    set((state) =>
      produce(state, (state) => {
        subscriptions.forEach((subscription) => {
          state.data[subscription.feedId] = omit(subscription, "feeds")
          state.feedIdByView[subscription.view].push(subscription.feedId)

          return state
        })
      }),
    )
  }

  async markReadByView(view: FeedViewType, filter?: MarkReadFilter) {
    doMutationAndTransaction(
      () =>
        apiClient.reads.all.$post({
          json: {
            view,
            ...filter,
          },
        }),
      async () => {
        const state = get()
        for (const feedId in state.data) {
          if (state.data[feedId].view === view) {
            // We can not process this logic in local, so skip it. and then we will fetch the unread count from server.
            !filter && feedUnreadActions.updateByFeedId(feedId, 0)
            entryActions.patchManyByFeedId(feedId, { read: true }, filter)
          }
        }
        if (filter) {
          feedUnreadActions.fetchUnreadByView(view)
        }
      },
    )
  }

  async markReadByFeedIds(feedIds: string[]): Promise<void>
  async markReadByFeedIds(
    feedIds: string[],
    view: FeedViewType,
    filter?: MarkReadFilter,
  ): Promise<void>
  async markReadByFeedIds(...args: [string[], FeedViewType?, MarkReadFilter?]) {
    const [feedIds, view, filter] = args

    const stableFeedIds = feedIds.concat()

    doMutationAndTransaction(
      () =>
        apiClient.reads.all.$post({
          json: {
            feedIdList: stableFeedIds,
            ...filter,
          },
        }),
      async () => {
        for (const feedId of stableFeedIds) {
          // We can not process this logic in local, so skip it. and then we will fetch the unread count from server.
          !filter && feedUnreadActions.updateByFeedId(feedId, 0)
          entryActions.patchManyByFeedId(feedId, { read: true }, filter)
        }
        if (filter) {
          feedUnreadActions.fetchUnreadByView(view)
        }
      },
    )
  }

  clear() {
    set({
      data: {},
      feedIdByView: { ...emptyDataIdByView },
    })
  }

  deleteCategory(ids: string[]) {
    const idSet = new Set(ids)

    return doMutationAndTransaction(
      () =>
        apiClient.categories.$delete({
          json: {
            feedIdList: ids,
            deleteSubscriptions: false,
          },
        }),
      async () => {
        set((state) =>
          produce(state, (state) => {
            Object.keys(state.data).forEach((id) => {
              if (idSet.has(id)) {
                const subscription = state.data[id]
                const feed = getFeedById(subscription.feedId)
                if (!feed) return
                const { siteUrl } = feed
                if (!siteUrl) return
                const parsed = parse(siteUrl)
                subscription.category = null
                // The logic for removing Category here is to use domain as the default category name.
                parsed.domain &&
                  (subscription.defaultCategory = capitalizeFirstLetter(parsed.domain))
              }
            })
          }),
        )
        const { data } = get()
        return ids.map((id) => data[id] && SubscriptionService.upsert(data[id]))
      },
      {
        doTranscationWhenMutationFail: false,
        waitMutation: true,
      },
    )
  }

  async unfollow(feedId: string) {
    const feed = getFeedById(feedId)
    // Remove feed and subscription
    set((state) =>
      produce(state, (draft) => {
        delete draft.data[feedId]
        for (const view in draft.feedIdByView) {
          const currentViewFeedIds = draft.feedIdByView[view] as string[]
          currentViewFeedIds.splice(currentViewFeedIds.indexOf(feedId), 1)
        }
      }),
    )

    // Remove feed's entries
    entryActions.clearByFeedId(feedId)
    // Clear feed's unread count
    feedUnreadActions.updateByFeedId(feedId, 0)

    return doMutationAndTransaction(
      () =>
        apiClient.subscriptions
          .$delete({
            json: {
              feedId,
            },
          })
          .then(() => feed),
      () => SubscriptionService.removeSubscription(whoami()!.id, feedId),
    ).then(() => feed)
  }

  async changeCategoryView(
    category: string,
    currentView: FeedViewType,
    changeToView: FeedViewType,
  ) {
    const state = get()
    const folderFeedIds = [] as string[]
    for (const feedId of state.feedIdByView[currentView]) {
      const subscription = state.data[feedId]
      if (!subscription) continue
      if (subscription.category === category || subscription.defaultCategory === category) {
        folderFeedIds.push(feedId)
      }
    }
    await Promise.all(
      folderFeedIds.map((feedId) =>
        apiClient.subscriptions.$patch({
          json: {
            feedId,
            view: changeToView,
          },
        }),
      ),
    )

    set((state) =>
      produce(state, (state) => {
        for (const feedId of folderFeedIds) {
          const feed = state.data[feedId]
          if (feed) feed.view = changeToView
          const currentViewFeedIds = state.feedIdByView[currentView] as string[]
          const changeToViewFeedIds = state.feedIdByView[changeToView] as string[]
          currentViewFeedIds.splice(currentViewFeedIds.indexOf(feedId), 1)
          changeToViewFeedIds.push(feedId)
        }
      }),
    )

    await Promise.all(
      folderFeedIds.map((feedId) => SubscriptionService.changeView(feedId, changeToView)),
    )
  }

  async renameCategory(lastCategory: string, newCategory: string) {
    const subscriptionIds = [] as string[]
    const state = get()
    for (const feedId in state.data) {
      const subscription = state.data[feedId]
      if (subscription.category === lastCategory || subscription.defaultCategory === lastCategory) {
        subscriptionIds.push(feedId)
      }
    }

    set((state) =>
      produce(state, (state) => {
        for (const feedId of subscriptionIds) {
          const subscription = state.data[feedId]
          if (subscription) {
            subscription.category = newCategory
            subscription.defaultCategory = undefined
          }
        }
      }),
    )

    return doMutationAndTransaction(
      () =>
        apiClient.categories.$patch({
          json: {
            feedIdList: subscriptionIds,
            category: newCategory,
          },
        }),
      async () =>
        // Db

        SubscriptionService.renameCategory(whoami()!.id, subscriptionIds, newCategory),
    )
  }
}

export const subscriptionActions = new SubscriptionActions()

export const getSubscriptionByFeedId = (feedId: FeedId) => {
  const state = get()
  return state.data[feedId]
}
