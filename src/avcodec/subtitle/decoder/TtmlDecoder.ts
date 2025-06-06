/*
 * libmedia webvtt decode
 *
 * 版权所有 (C) 2024 赵高兴
 * Copyright (C) 2024 Gaoxing Zhao
 *
 * 此文件是 libmedia 的一部分
 * This file is part of libmedia.
 * 
 * libmedia 是自由软件；您可以根据 GNU Lesser General Public License（GNU LGPL）3.1
 * 或任何其更新的版本条款重新分发或修改它
 * libmedia is free software; you can redistribute it and/or
 * modify it under the terms of the GNU Lesser General Public
 * License as published by the Free Software Foundation; either
 * version 3.1 of the License, or (at your option) any later version.
 * 
 * libmedia 希望能够为您提供帮助，但不提供任何明示或暗示的担保，包括但不限于适销性或特定用途的保证
 * 您应自行承担使用 libmedia 的风险，并且需要遵守 GNU Lesser General Public License 中的条款和条件。
 * libmedia is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
 * Lesser General Public License for more details.
 *
 */

import AVPacket from 'avutil/struct/avpacket'
import Decoder from './Decoder'
import * as text from 'common/util/text'
import { getAVPacketData } from 'avutil/util/avpacket'
import { AV_MILLI_TIME_BASE } from 'avutil/constant'
import { AVSubtitle, AVSubtitleType } from 'avutil/struct/avsubtitle'
import * as ittml from 'avutil/codecs/ttml'

export default class TtmlDecoder extends Decoder {

  private queue: {
    pts: int64
    duration: int64
    context: string
    region: string
  }[]

  constructor() {
    super()
    this.queue = []
  }

  public sendAVPacket(avpacket: pointer<AVPacket>): int32 {
    let context = text.decode(getAVPacketData(avpacket))

    if (!context) {
      return 0
    }

    if (/<tt/.test(context.trim())) {
      this.queue = this.queue.concat(ittml.parse(context).queue)
    }
    else {
      this.queue.push({
        pts: avpacket.pts,
        duration: avpacket.duration,
        context,
        region: 'Default'
      })
    }

    return 0
  }

  public receiveAVFrame(sub: AVSubtitle): int32 {
    if (this.queue.length) {
      const item = this.queue.shift()!

      sub.pts = item.pts
      sub.duration = item.duration
      sub.timeBase.den = AV_MILLI_TIME_BASE
      sub.timeBase.num = 1
      sub.rects.push({
        type: AVSubtitleType.SUBTITLE_WEBVTT,
        text: item.context,
        flags: 0
      })

      return 1
    }
    return 0
  }

  public flush(): int32 {
    return 0
  }
}
