import { useForceUpdate } from "framer-motion"
import type { FC, ImgHTMLAttributes, VideoHTMLAttributes } from "react"
import { memo, useMemo, useState } from "react"
import { useEventCallback } from "usehooks-ts"

import { nextFrame } from "~/lib/dom"
import { getImageProxyUrl } from "~/lib/img-proxy"
import { cn } from "~/lib/utils"
import { saveImageDimensionsToDb } from "~/store/image/db"

import { usePreviewMedia } from "./media/hooks"
import type { VideoPlayerRef } from "./media/VideoPlayer"
import { VideoPlayer } from "./media/VideoPlayer"

const failedList = new Set<string | undefined>()

type BaseProps = {
  mediaContainerClassName?: string
  showFallback?: boolean
}
export type MediaProps = BaseProps &
  (
    | (ImgHTMLAttributes<HTMLImageElement> & {
        proxy?: {
          width: number
          height: number
        }
        popper?: boolean
        type: "photo"
        previewImageUrl?: string
        cacheDimensions?: boolean
      })
    | (VideoHTMLAttributes<HTMLVideoElement> & {
        proxy?: {
          width: number
          height: number
        }
        popper?: boolean
        type: "video"
        previewImageUrl?: string
      })
  )
const MediaImpl: FC<MediaProps> = ({
  className,
  proxy,
  popper = false,
  mediaContainerClassName,
  ...props
}) => {
  const { src, style, type, previewImageUrl, showFallback, ...rest } = props
  const [hidden, setHidden] = useState(!src)
  const [imgSrc, setImgSrc] = useState(() =>
    proxy && src && !failedList.has(src)
      ? getImageProxyUrl({
          url: src,
          width: proxy.width,
          height: proxy.height,
        })
      : src,
  )

  const [mediaLoadState, setMediaLoadState] = useState<"loading" | "loaded" | "error">("loading")
  const errorHandle: React.ReactEventHandler<HTMLImageElement> = useEventCallback((e) => {
    setMediaLoadState("error")
    if (imgSrc !== props.src) {
      setImgSrc(props.src)
      failedList.add(props.src)
    } else {
      setHidden(true)
      props.onError?.(e as any)
    }
  })
  const previewMedia = usePreviewMedia()
  const handleClick = useEventCallback((e: React.MouseEvent) => {
    if (popper && src) {
      previewMedia(
        [
          {
            url: src,
            type,
            fallbackUrl: imgSrc,
          },
        ],
        0,
      )
    }
    props.onClick?.(e as any)
  })
  const handleOnLoad: React.ReactEventHandler<HTMLImageElement> = useEventCallback((e) => {
    setMediaLoadState("loaded")
    rest.onLoad?.(e as any)
    if ("cacheDimensions" in props && props.cacheDimensions && src) {
      saveImageDimensionsToDb(src, {
        src,
        width: e.currentTarget.naturalWidth,
        height: e.currentTarget.naturalHeight,
        ratio: e.currentTarget.naturalWidth / e.currentTarget.naturalHeight,
      })
    }
  })

  const InnerContent = useMemo(() => {
    switch (type) {
      case "photo": {
        return (
          <img
            {...(rest as ImgHTMLAttributes<HTMLImageElement>)}
            onError={errorHandle}
            className={cn(
              !(props.width || props.height) && "size-full",
              "bg-gray-200 object-cover duration-200 dark:bg-neutral-800",
              popper && "cursor-zoom-in",
              mediaLoadState === "loaded" ? "opacity-100" : "opacity-0",

              mediaContainerClassName,
            )}
            src={imgSrc}
            onLoad={handleOnLoad}
            onClick={handleClick}
          />
        )
      }
      case "video": {
        return (
          <span
            className={cn(
              "center",
              !(props.width || props.height) && "size-full",
              "relative bg-stone-100 object-cover",
              mediaContainerClassName,
            )}
            onClick={handleClick}
          >
            <VideoPreview src={src!} previewImageUrl={previewImageUrl} />
          </span>
        )
      }
      default: {
        return null
      }
    }
  }, [
    errorHandle,
    handleClick,
    handleOnLoad,
    imgSrc,
    mediaContainerClassName,
    mediaLoadState,
    popper,
    previewImageUrl,
    props,
    rest,
    src,
    type,
  ])

  if (!type || !src) return null

  if (hidden && showFallback) {
    return (
      <FallbackMedia
        mediaContainerClassName={mediaContainerClassName}
        className={className}
        {...props}
      />
    )
  }
  return (
    <span
      data-state={type !== "video" ? mediaLoadState : undefined}
      className={cn("block overflow-hidden rounded", hidden && "hidden", className)}
      style={style}
    >
      {InnerContent}
    </span>
  )
}

export const Media: FC<MediaProps> = memo((props) => <MediaImpl {...props} key={props.src} />)

const FallbackMedia: FC<MediaProps> = ({ type, mediaContainerClassName, className, ...props }) => (
  <div className={className}>
    <div
      className={cn(
        !(props.width || props.height) && "size-full",
        "center relative rounded bg-zinc-100 object-cover dark:bg-neutral-900",
        "not-prose flex max-h-full flex-col space-y-1 p-4",
        mediaContainerClassName,
      )}
      style={{
        height: props.height ? `${props.height}px` : "",
        width: props.width ? `${props.width}px` : "100%",
        ...props.style,
      }}
    >
      <i className="i-mgc-close-cute-re text-xl text-red-500" />
      <p>Media loaded failed</p>
      <div className="space-x-1 break-all px-4 text-sm">
        Go to{" "}
        <a href={props.src} target="_blank" rel="noreferrer" className="follow-link--underline">
          {props.src}
        </a>
        <i className="i-mgc-external-link-cute-re translate-y-px" />
      </div>
    </div>
  </div>
)

const VideoPreview: FC<{
  src: string
  previewImageUrl?: string
}> = ({ src, previewImageUrl }) => {
  const [isInitVideoPlayer, setIsInitVideoPlayer] = useState(!previewImageUrl)

  const [videoRef, setVideoRef] = useState<VideoPlayerRef | null>(null)
  const isPaused = videoRef ? videoRef?.getState().paused : true
  const [forceUpdate] = useForceUpdate()
  return (
    <div
      onMouseEnter={() => {
        videoRef?.controls.play()?.then(forceUpdate)
      }}
      onMouseLeave={() => {
        videoRef?.controls.pause()
        nextFrame(forceUpdate)
      }}
    >
      {!isInitVideoPlayer ? (
        <img
          src={previewImageUrl}
          className="size-full object-cover"
          onMouseEnter={() => {
            setIsInitVideoPlayer(true)
          }}
        />
      ) : (
        <VideoPlayer
          variant="preview"
          controls={false}
          src={src}
          ref={setVideoRef}
          muted
          className="relative size-full object-cover"
        />
      )}

      <div
        className={cn(
          "absolute left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 rounded-full bg-black/50 p-2 text-3xl text-white/80 duration-200",
          isPaused ? "opacity-100" : "opacity-0",
        )}
      >
        <i className="i-mgc-play-cute-fi" />
      </div>
    </div>
  )
}
