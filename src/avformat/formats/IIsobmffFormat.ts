/*
 * libmedia isobmff decoder
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

import type AVPacket from 'avutil/struct/avpacket'
import { AVPacketFlags } from 'avutil/struct/avpacket'
import type { AVIFormatContext } from '../AVFormatContext'
import * as logger from 'common/util/logger'
import * as errorType from 'avutil/error'

import { IOError } from 'common/io/error'
import type { IsobmffContext, IsobmffStreamContext } from './isobmff/type'
import mktag from '../function/mktag'
import { BoxType } from './isobmff/boxType'
import * as iisobmff from './isobmff/iisobmff'
import { AVCodecID, AVMediaType, AVPacketSideDataType } from 'avutil/codec'
import IFormat from './IFormat'
import { getNextSample } from './isobmff/function/getNextSample'
import createIsobmffContext from './isobmff/function/createIsobmffContext'
import { AVFormat, AVSeekFlags } from 'avutil/avformat'
import * as array from 'common/util/array'
import { mapSafeUint8Array, memcpy, memcpyFromUint8Array } from 'cheap/std/memory'
import { avMalloc, avMallocz } from 'avutil/util/mem'
import { addAVPacketData, addAVPacketSideData, createAVPacket } from 'avutil/util/avpacket'
import { avRescaleQ } from 'avutil/util/rational'
import type AVStream from 'avutil/AVStream'
import { AV_MILLI_TIME_BASE_Q, NOPTS_VALUE_BIGINT } from 'avutil/constant'
import { IOFlags } from 'avutil/avformat'
import * as intread from 'avutil/util/intread'
import { encryptionInfo2SideData } from 'avutil/util/encryption'
import { AVCodecParameterFlags } from 'avutil/struct/avcodecparameters'
import * as object from 'common/util/object'
import { AVDiscard, AVDisposition } from 'avutil/AVStream'
import createIsobmffStreamContext from './isobmff/function/createIsobmffStreamContext'
import * as text from 'common/util/text'
import digital2Tag from '../function/digital2Tag'

export interface IIsobmffFormatOptions {
  /**
   * 忽略 editlist 的约束
   */
  ignoreEditlist?: boolean

  ignoreChapters?: boolean
}

export default class IIsobmffFormat extends IFormat {

  public type: AVFormat = AVFormat.ISOBMFF

  private context: IsobmffContext
  private firstAfterSeek: boolean

  public options: IIsobmffFormatOptions

  constructor(options: IIsobmffFormatOptions = {}) {
    super()

    this.options = options
    this.context = createIsobmffContext()
    if (options.ignoreEditlist) {
      this.context.ignoreEditlist = true
    }
  }

  public init(formatContext: AVIFormatContext): void {
    if (formatContext.ioReader) {
      formatContext.ioReader.setEndian(true)
    }
    this.firstAfterSeek = false
  }

  public async readHeader(formatContext: AVIFormatContext): Promise<number> {
    try {

      const fileSize = await formatContext.ioReader.fileSize()

      let ret = 0

      let size = await formatContext.ioReader.readUint32()
      let type = await formatContext.ioReader.readUint32()

      if (type === mktag(BoxType.FTYP)) {
        await iisobmff.readFtyp(formatContext.ioReader, this.context, {
          type,
          size: size - 8
        })
      }
      else if (!fileSize || size < fileSize) {
        await formatContext.ioReader.skip(size - 8)
      }

      let firstMdatPos = 0n

      while (!this.context.foundMoov) {
        const pos = formatContext.ioReader.getPos()

        if (pos === fileSize) {
          if (this.context.foundHEIF) {
            break
          }
          logger.error('the file format is not mp4')
          return errorType.DATA_INVALID
        }

        size = await formatContext.ioReader.readUint32()
        type = await formatContext.ioReader.readUint32()

        // size 大于 32 位
        if (size === 1) {
          size = static_cast<double>(await formatContext.ioReader.readUint64())
        }

        if (size < 8
          || (fileSize && (pos + static_cast<int64>(size) > fileSize))
          || !/^[\x20-\x7E]{4}$/.test(digital2Tag(type))
        ) {
          if (this.context.foundMdat && (
            this.context.foundMoov || this.context.foundHEIF
          )) {
            break
          }
          logger.error(`invalid box size ${size}`)
          return errorType.DATA_INVALID
        }

        if (type === mktag(BoxType.MDAT)) {
          if (!this.context.foundMdat) {
            firstMdatPos = pos
          }
          this.context.foundMdat = true
          await formatContext.ioReader.seek(pos + static_cast<int64>(size), false, false)
        }
        else if (type === mktag(BoxType.MOOV)) {
          await iisobmff.readMoov(formatContext.ioReader, formatContext, this.context, {
            size: size - 8,
            type
          })
          this.context.foundMoov = true
        }
        else if (type === mktag(BoxType.META)
          && (this.context.majorBrand === mktag('avif')
            || this.context.majorBrand === mktag('avis')
            || this.context.majorBrand === mktag('heic')
            || this.context.majorBrand === mktag('heix')
            || this.context.majorBrand === mktag('hevc')
            || this.context.majorBrand === mktag('hevx')
            || this.context.majorBrand === mktag('mif1')
            || this.context.majorBrand === mktag('msf1')
          )
        ) {
          await iisobmff.readHEIF(formatContext.ioReader, formatContext, this.context, {
            size: size - 8,
            type
          })
        }
        else {
          await formatContext.ioReader.seek(pos + static_cast<int64>(size))
        }
      }

      if (!this.context.fragment && !this.context.foundMdat) {
        const nextType = (await formatContext.ioReader.peekUint64()) >> 32n
        if (Number(nextType) === mktag(BoxType.MOOF)) {
          this.context.fragment = true
        }
      }

      if (this.context.fragment && formatContext.ioReader.flags & IOFlags.SEEKABLE) {
        const now = formatContext.ioReader.getPos()
        const fileSize = await formatContext.ioReader.fileSize()

        if (fileSize > 16n) {
          await formatContext.ioReader.seek(fileSize - 12n)
          let type = await formatContext.ioReader.readUint32()
          if (type === mktag(BoxType.MFRO)) {
            await formatContext.ioReader.skip(4)
            const mfraSize = await formatContext.ioReader.readUint32()
            await formatContext.ioReader.seek(fileSize - static_cast<int64>(mfraSize))
            const size = await formatContext.ioReader.readUint32()
            type = await formatContext.ioReader.readUint32()
            if (type === mktag(BoxType.MFRA)) {
              await iisobmff.readMfra(formatContext.ioReader, formatContext, this.context, {
                size: size - 8,
                type
              })
            }
          }
          await formatContext.ioReader.seek(now)
        }
      }

      if (!this.context.fragment && this.context.foundMdat) {
        await formatContext.ioReader.seek(firstMdatPos)
      }

      if (!this.context.fragment) {
        formatContext.streams.forEach((stream) => {
          if (stream.codecpar.codecId === AVCodecID.AV_CODEC_ID_H264
            || stream.codecpar.codecId === AVCodecID.AV_CODEC_ID_HEVC
            || stream.codecpar.codecId === AVCodecID.AV_CODEC_ID_VVC
          ) {
            const streamContext = stream.privData as IsobmffStreamContext
            if (stream.codecpar.videoDelay > 0
              && (!streamContext.cttsSampleCounts
                || !streamContext.cttsSampleCounts.length
              )
            ) {
              stream.codecpar.flags |= AVCodecParameterFlags.AV_CODECPAR_FLAG_NO_PTS
            }
          }
        })
      }

      if (this.context.metadata) {
        object.extend(formatContext.metadata, this.context.metadata)
      }
      if (this.context.chapters?.length) {
        for (let i = 1; i < this.context.chapters.length; i++) {
          this.context.chapters[i - 1].end = avRescaleQ(
            this.context.chapters[i].start,
            this.context.chapters[i].timeBase,
            this.context.chapters[i - 1].timeBase,
          )
        }
        const lastChapter = this.context.chapters[this.context.chapters.length - 1]
        formatContext.streams.forEach((stream) => {
          const d = avRescaleQ(stream.duration, stream.timeBase, lastChapter.timeBase)
          if (d > lastChapter.end) {
            lastChapter.end = d
          }
        })
        formatContext.chapters.push(...this.context.chapters)
      }
      if (this.context.covr) {
        let codecId = AVCodecID.AV_CODEC_ID_NONE

        switch (this.context.covr.type) {
          case 0xd:
            codecId = AVCodecID.AV_CODEC_ID_MJPEG
            break
          case 0xe:
            codecId = AVCodecID.AV_CODEC_ID_PNG
            break
          case 0x1b:
            codecId = AVCodecID.AV_CODEC_ID_BMP
            break
          default:
            logger.error(`"Unknown cover type: ${this.context.covr.type}`)
        }

        if (codecId) {
          if (this.context.covr.data.length >= 8
            && codecId !== AVCodecID.AV_CODEC_ID_BMP
          ) {
            if (array.same(this.context.covr.data.subarray(0, 8), new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]))) {
              codecId = AVCodecID.AV_CODEC_ID_PNG
            }
            else {
              codecId = AVCodecID.AV_CODEC_ID_MJPEG
            }
          }

          const stream = formatContext.createStream()
          stream.privData = createIsobmffStreamContext()
          stream.codecpar.codecId = codecId
          stream.codecpar.codecType = AVMediaType.AVMEDIA_TYPE_VIDEO
          stream.disposition |= AVDisposition.ATTACHED_PIC
          stream.attachedPic = createAVPacket()
          stream.attachedPic.streamIndex = stream.index
          const data: pointer<uint8> = avMalloc(this.context.covr.data.length)
          memcpyFromUint8Array(data, this.context.covr.data.length, this.context.covr.data)
          addAVPacketData(stream.attachedPic, data, this.context.covr.data.length)
          stream.attachedPic.flags |= AVPacketFlags.AV_PKT_FLAG_KEY
        }
      }
      if (this.context.chapterTrack && (formatContext.ioReader.flags & IOFlags.SEEKABLE) && !this.options.ignoreChapters) {
        for (let i = 0; i < this.context.chapterTrack.length; i++) {
          const trackId = this.context.chapterTrack[i]
          const stream = formatContext.streams.find((stream) => {
            const track = stream.privData as IsobmffStreamContext
            return track.trackId === trackId
          })
          if (stream) {
            const now = formatContext.ioReader.getPos()
            const track = stream.privData as IsobmffStreamContext
            if (stream.codecpar.codecType === AVMediaType.AVMEDIA_TYPE_VIDEO) {
              stream.disposition |= AVDisposition.ATTACHED_PIC
              stream.disposition |= AVDisposition.TIMED_THUMBNAILS
              if (!stream.attachedPic) {
                const sample = track.samplesIndex[0]
                if (sample) {
                  await formatContext.ioReader.seek(sample.pos)
                  stream.attachedPic = createAVPacket()
                  stream.attachedPic.streamIndex = stream.index
                  stream.attachedPic.dts = sample.dts
                  stream.attachedPic.pts = sample.pts
                  stream.attachedPic.flags |= sample.flags
                  stream.attachedPic.flags |= AVPacketFlags.AV_PKT_FLAG_KEY
                  stream.attachedPic.pos = sample.pos
                  const data: pointer<uint8> = avMalloc(sample.size)
                  memcpyFromUint8Array(data, sample.size, await formatContext.ioReader.readBuffer(sample.size))
                  addAVPacketData(stream.attachedPic, data, sample.size)
                }
              }
            }
            else {
              stream.codecpar.codecType = AVMediaType.AVMEDIA_TYPE_DATA
              stream.codecpar.codecId = AVCodecID.AV_CODEC_ID_BIN_DATA
              stream.discard = AVDiscard.AVDISCARD_ALL
              for (let i = 0; i < track.samplesIndex.length; i++) {
                const sample = track.samplesIndex[i]
                await formatContext.ioReader.seek(sample.pos)
                const len = await formatContext.ioReader.readUint16()
                if (len > sample.size - 2) {
                  continue
                }
                let end = sample.pts + static_cast<int64>(sample.duration as int32)
                if (end < sample.pts) {
                  end = NOPTS_VALUE_BIGINT
                }
                formatContext.chapters.push({
                  id: static_cast<uint64>(i as uint32),
                  timeBase: {
                    den: stream.timeBase.den,
                    num: stream.timeBase.num
                  },
                  start: sample.pts,
                  end,
                  metadata: {
                    title: len ? text.decode(await formatContext.ioReader.readBuffer(len)) : ''
                  }
                })
              }
            }
            await formatContext.ioReader.seek(now)
          }
        }
      }

      return ret
    }
    catch (error) {

      logger.error(error.message)

      if (!this.context.foundMoov) {
        logger.error('moov not found')
      }

      return formatContext.ioReader.error
    }
  }

  private async readAVPacket_(formatContext: AVIFormatContext, avpacket: pointer<AVPacket>): Promise<number> {

    const { sample, stream, encryption } = getNextSample(formatContext, this.context, formatContext.ioReader.flags)

    if (sample) {
      avpacket.streamIndex = stream.index
      avpacket.dts = sample.dts
      if (!(stream.codecpar.flags & AVCodecParameterFlags.AV_CODECPAR_FLAG_NO_PTS)) {
        avpacket.pts = sample.pts
      }
      avpacket.duration = static_cast<int64>(sample.duration)
      avpacket.flags |= sample.flags
      avpacket.pos = sample.pos
      avpacket.timeBase.den = stream.timeBase.den
      avpacket.timeBase.num = stream.timeBase.num

      if (stream.startTime === NOPTS_VALUE_BIGINT) {
        stream.startTime = avpacket.pts
      }

      const skip = avpacket.pos - formatContext.ioReader.getPos()
      if (skip !== 0n) {
        // NETWORK 优先 pos，pos 是递增的，这里我们使用 skip
        // 防止触发 seek
        if (skip > 0
          && ((formatContext.ioReader.flags & IOFlags.NETWORK)
            || (formatContext.ioReader.flags & IOFlags.SLICE)
          )
          && !this.firstAfterSeek
        ) {
          await formatContext.ioReader.skip(static_cast<int32>(skip))
        }
        else {
          await formatContext.ioReader.seek(avpacket.pos)
        }
      }
      if (this.firstAfterSeek) {
        this.firstAfterSeek = false
      }

      const len = sample.size
      const data: pointer<uint8> = avMalloc(len)
      addAVPacketData(avpacket, data, len)
      await formatContext.ioReader.readBuffer(len, mapSafeUint8Array(data, len))

      if (stream.codecpar.codecId === AVCodecID.AV_CODEC_ID_WEBVTT
        && avpacket.size >= 8
      ) {
        const tag = static_cast<uint32>(intread.rb32(avpacket.data + 4))
        const packetSize = avpacket.size
        if (tag === mktag(BoxType.VTTE)) {
          if (packetSize === 8) {
            const newData: pointer<uint8> = avMallocz(1)
            addAVPacketData(avpacket, newData, 1)
            avpacket.size = 1
          }
        }
        if (packetSize > 8 && (tag === mktag(BoxType.VTTE) || tag === mktag(BoxType.VTTC))) {
          let start: pointer<uint8> = (avpacket.data + 8) as pointer<uint8>
          const end: pointer<uint8> = (avpacket.data + packetSize) as pointer<uint8>
          while (start < end) {
            const size = intread.rb32(start)
            const tag = static_cast<uint32>(intread.rb32(start + 4))
            if (tag === mktag(BoxType.PAYL) && size > 8) {
              const newData: pointer<uint8> = avMalloc(size - 8)
              memcpy(newData, (start + 8) as pointer<uint8>, size - 8)
              addAVPacketData(avpacket, newData, size - 8)
              break
            }
            else {
              start = reinterpret_cast<pointer<uint8>>(start + size)
            }
          }
        }
      }

      if (stream.sideData[AVPacketSideDataType.AV_PKT_DATA_NEW_EXTRADATA]
        && (avpacket.flags & AVPacketFlags.AV_PKT_FLAG_KEY)
      ) {
        const len = stream.sideData[AVPacketSideDataType.AV_PKT_DATA_NEW_EXTRADATA].length
        const extradata = avMalloc(len)
        addAVPacketSideData(avpacket, AVPacketSideDataType.AV_PKT_DATA_NEW_EXTRADATA, extradata, len)
        memcpyFromUint8Array(extradata, len, stream.sideData[AVPacketSideDataType.AV_PKT_DATA_NEW_EXTRADATA])
        delete stream.sideData[AVPacketSideDataType.AV_PKT_DATA_NEW_EXTRADATA]
      }
      if (encryption) {
        const buffer = encryptionInfo2SideData(encryption)
        const data: pointer<uint8> = avMalloc(buffer.length)
        memcpyFromUint8Array(data, buffer.length, buffer)
        addAVPacketSideData(avpacket, AVPacketSideDataType.AV_PKT_DATA_ENCRYPTION_INFO, data, buffer.length)
      }
    }
    else {
      return IOError.END
    }

    return 0
  }

  public async readAVPacket(formatContext: AVIFormatContext, avpacket: pointer<AVPacket>): Promise<number> {
    try {
      const hasSample = !!formatContext.streams.find((stream) => {
        const context = stream.privData as IsobmffStreamContext
        return context.samplesIndex?.length && context.sampleEnd === false
      })
      // 一些 fmp4 的 moov 里面存着一段样本
      // 这里先判断有没有 sample
      if (!hasSample && this.context.fragment && !this.context.currentFragment) {
        while (!this.context.currentFragment) {
          const pos = formatContext.ioReader.getPos()
          const size = await formatContext.ioReader.readUint32()
          const type = await formatContext.ioReader.readUint32()

          if (type === mktag(BoxType.MOOF)) {
            this.context.currentFragment = {
              pos: pos,
              size,
              sequence: 0,
              tracks: [],
              currentTrack: null
            }

            if (!this.context.firstMoof) {
              this.context.firstMoof = pos
            }

            await iisobmff.readMoof(
              formatContext.ioReader,
              formatContext,
              this.context,
              {
                type,
                size: size - 8
              }
            )
          }
          else if (type === mktag(BoxType.MOOV)) {
            await iisobmff.readMoov(formatContext.ioReader, formatContext, this.context, {
              size: size - 8,
              type
            })
          }
          else {
            await formatContext.ioReader.skip(size - 8)
          }
        }
      }

      return await this.readAVPacket_(formatContext, avpacket)
    }
    catch (error) {
      if (formatContext.ioReader.error !== IOError.END
        && formatContext.ioReader.error !== IOError.ABORT
      ) {
        logger.error(`read packet error, ${error}`)
        return errorType.DATA_INVALID
      }
      return formatContext.ioReader.error
    }
  }


  public async seek(
    formatContext: AVIFormatContext,
    stream: AVStream,
    timestamp: int64,
    flags: int32
  ): Promise<int64> {

    assert(stream)

    const now = formatContext.ioReader.getPos()

    if (flags & AVSeekFlags.BYTE) {
      await formatContext.ioReader.seek(timestamp)
      return now
    }

    const pts = timestamp

    const streamContext = stream.privData as IsobmffStreamContext

    const resetFragment = () => {
      this.context.currentFragment = null
      formatContext.streams.forEach((stream) => {
        const isobmffStreamContext = stream.privData as IsobmffStreamContext
        isobmffStreamContext.samplesIndex.length = 0
      })
    }

    // dash 使用时间戳去 seek
    if (flags & AVSeekFlags.TIMESTAMP && this.context.fragment) {
      const seekTime = avRescaleQ(timestamp, stream.timeBase, AV_MILLI_TIME_BASE_Q)
      await formatContext.ioReader.seek(seekTime, true)
      resetFragment()
      return now
    }

    if (this.context.fragment) {
      if (streamContext.fragIndexes.length) {
        let index = array.binarySearch(streamContext.fragIndexes, (item) => {
          if (item.time > pts) {
            return -1
          }
          else if (item.time === pts) {
            return 0
          }
          return 1
        })
        if (index > -1) {
          if (index > 0 && streamContext.fragIndexes[index].time > pts) {
            index--
          }
          await formatContext.ioReader.seek(streamContext.fragIndexes[index].pos, true)
          resetFragment()
          return now
        }
      }
      if (pts === 0n && this.context.firstMoof) {
        await formatContext.ioReader.seek(this.context.firstMoof)
        resetFragment()
        return now
      }
      return static_cast<int64>(errorType.FORMAT_NOT_SUPPORT)
    }

    let index = array.binarySearch(streamContext.samplesIndex, (item) => {
      if (item.pts > pts) {
        return -1
      }
      else if (item.pts === pts) {
        return 0
      }
      return 1
    })

    if (index > -1 && stream.codecpar.codecType === AVMediaType.AVMEDIA_TYPE_VIDEO) {
      let i = index
      for (; i >= 0; i--) {
        if (streamContext.samplesIndex[i].flags & AVPacketFlags.AV_PKT_FLAG_KEY) {
          index = i
          break
        }
      }
      if (i < 0) {
        index = -1
      }
    }

    if (index > -1) {
      streamContext.currentSample = index
      streamContext.sampleEnd = false
      array.each(formatContext.streams, (st) => {
        if (st !== stream && !(st.disposition & AVDisposition.ATTACHED_PIC)) {
          const stContext = st.privData as IsobmffStreamContext
          let timestamp = avRescaleQ(streamContext.samplesIndex[streamContext.currentSample].pts, stream.timeBase, st.timeBase)

          let index = array.binarySearch(stContext.samplesIndex, (sample) => {
            if (sample.pts > timestamp) {
              return -1
            }
            else if (sample.pts === timestamp) {
              return 0
            }
            return 1
          })

          if (index > -1 && st.codecpar.codecType === AVMediaType.AVMEDIA_TYPE_VIDEO) {
            let i = index
            for (; i >= 0; i--) {
              if (stContext.samplesIndex[i].flags & AVPacketFlags.AV_PKT_FLAG_KEY) {
                index = i
                break
              }
            }
            if (i < 0) {
              index = -1
            }
          }

          if (index >= 0) {
            stContext.currentSample = index
            stContext.sampleEnd = false
          }
          else {
            stContext.sampleEnd = true
            stContext.currentSample = stContext.samplesIndex.length
          }
        }
      })
      this.firstAfterSeek = true
      return now
    }
    return static_cast<int64>(errorType.DATA_INVALID)
  }

  public getAnalyzeStreamsCount(): number {
    // isobmff 在 readheader 时分析了 moov，不需要在进行流分析
    return 0
  }
}
