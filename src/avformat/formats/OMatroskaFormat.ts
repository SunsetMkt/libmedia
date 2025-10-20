/*
 * libmedia matroska encoder
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

import type { AVOFormatContext } from '../AVFormatContext'
import type AVPacket from 'avutil/struct/avpacket'
import { AVPacketFlags } from 'avutil/struct/avpacket'
import OFormat from './OFormat'
import { AVCodecID, AVMediaType, AVPacketSideDataType } from 'avutil/codec'
import { AVFormat } from 'avutil/avformat'
import * as logger from 'common/util/logger'
import { avRescaleQ2 } from 'avutil/util/rational'
import { createAVPacket, destroyAVPacket, getAVPacketData, getAVPacketSideData, hasAVPacketSideData } from 'avutil/util/avpacket'
import * as object from 'common/util/object'
import type { Attachment, ChapterAtom, OMatroskaContext, TrackEntry } from './matroska/type'
import IOWriterSync from 'common/io/IOWriterSync'
import * as omatroska from './matroska/omatroska'
import { EBMLId, MATROSKABlockAddIdType, MATROSKATrackType, MkvImageMime2CodecId, MkvTag2CodecId, WebmTag2CodecId } from './matroska/matroska'
import * as crypto from 'avutil/util/crypto'
import type AVCodecParameters from 'avutil/struct/avcodecparameters'
import { mapUint8Array } from 'cheap/std/memory'
import { chromaLocation2Pos } from 'avutil/util/pixel'
import { AV_MILLI_TIME_BASE_Q, NOPTS_VALUE_BIGINT } from 'avutil/constant'
import * as string from 'common/util/string'
import type AVStream from 'avutil/AVStream'
import concatTypeArray from 'common/function/concatTypeArray'
import Annexb2AvccFilter from '../bsf/h2645/Annexb2AvccFilter'
import * as naluUtil from 'avutil/util/nalu'
import * as h264 from 'avutil/codecs/h264'
import * as hevc from 'avutil/codecs/hevc'
import * as vvc from 'avutil/codecs/vvc'
import * as intread from 'avutil/util/intread'
import type { Uint8ArrayInterface } from 'common/io/interface'
import { AVDisposition, AVStreamMetadataKey } from 'avutil/AVStream'
import * as errorType from 'avutil/error'
import * as is from 'common/util/is'
import getTimestamp from 'common/function/getTimestamp'
import * as text from 'common/util/text'
import toString from 'common/function/toString'

export interface OMatroskaFormatOptions {
  /**
   * 是否是直播
   */
  isLive?: boolean
  /**
   * mkv 还是 webm 
   */
  docType?: string
}

const defaultOMatroskaFormatOptions: OMatroskaFormatOptions = {
  isLive: false,
  docType: 'matroska'
}

function formatTimestamp(milliseconds: int64) {
  const hours = milliseconds / BigInt(1000 * 60 * 60)
  const remainingMilliseconds = milliseconds % BigInt(1000 * 60 * 60)

  const minutes = remainingMilliseconds / BigInt(1000 * 60)
  const remainingMillisecondsAfterMinutes = remainingMilliseconds % BigInt(1000 * 60)

  const seconds = remainingMillisecondsAfterMinutes / 1000n

  const ms = remainingMillisecondsAfterMinutes % 1000n

  return string.format(
    '%02d:%02d:%02d.%03d000000\x00\x00',
    static_cast<int32>(hours),
    static_cast<int32>(minutes),
    static_cast<int32>(seconds),
    static_cast<int32>(ms)
  )
}

export default class OMatroskaFormat extends OFormat {

  public type: AVFormat = AVFormat.MATROSKA

  private options: OMatroskaFormatOptions

  private context: OMatroskaContext

  private random: Uint8Array
  private randomView: DataView

  private avpacket: pointer<AVPacket>
  private annexb2AvccFilter: Annexb2AvccFilter

  constructor(options: OMatroskaFormatOptions = {}) {
    super()
    this.options = object.extend({}, defaultOMatroskaFormatOptions, options)

    this.random = new Uint8Array(8)
    this.randomView = new DataView(this.random.buffer)
  }

  public init(formatContext: AVOFormatContext): number {
    formatContext.ioWriter.setEndian(false)
    this.avpacket = createAVPacket()

    const context: OMatroskaContext = {
      isLive: this.options.isLive,
      segmentStart: -1n,
      seekHeadEnd: -1n,
      header: {
        version: 1,
        readVersion: 1,
        maxIdLength: 4,
        maxSizeLength: 8,
        docType: this.options.docType,
        docTypeVersion: 4,
        docTypeReadVersion: 2
      },
      seekHead: {
        entry: []
      },
      info: {
        muxingApp: `libmedia-${defined(VERSION)}`,
        writingApp: formatContext.metadata[AVStreamMetadataKey.ENCODER] ?? `libmedia-${defined(VERSION)}`,
        timestampScale: 1000000,
        duration: 0,
        segmentUUID: -1n
      },
      tracks: {
        entry: []
      },
      attachments: {
        entry: []
      },
      chapters: {
        entry: []
      },
      cues: {
        entry: []
      },
      tags: {
        entry: []
      },

      elePositionInfos: [],
      eleCaches: [],
      eleWriter: new IOWriterSync(),
      currentCluster: {
        timeCode: -1n,
        pos: -1n
      },
      hasVideo: false
    }

    if (formatContext.metadata[AVStreamMetadataKey.TITLE]) {
      context.info.title = formatContext.metadata[AVStreamMetadataKey.TITLE]
    }
    let ts = getTimestamp()
    if (formatContext.metadata[AVStreamMetadataKey.CREATION_TIME]) {
      ts = (new Date(formatContext.metadata[AVStreamMetadataKey.CREATION_TIME])).getTime()
    }
    this.randomView.setBigUint64(0, BigInt(ts - 978307200000) * 1000000n)
    context.info.dateUTC = {
      data: this.random.slice(),
      size: 8n,
      pos: NOPTS_VALUE_BIGINT
    }

    if (context.header.docType === 'webm') {
      context.header.docTypeVersion = 2
      context.header.docTypeReadVersion = 2
    }

    context.eleWriter.onFlush = (data) => {
      context.eleCaches.push(data.slice())
      return 0
    }

    crypto.random(this.random)
    context.info.segmentUUID = this.randomView.getBigUint64(0)

    formatContext.privateData = this.context = context

    const tag2CodecId = this.context.header.docType === 'webm' ? WebmTag2CodecId : MkvTag2CodecId

    function codecId2Tag(codecpar: AVCodecParameters) {
      let tag = ''
      object.each(tag2CodecId, (id, t) => {
        if (id === codecpar.codecId) {
          tag = t
        }
      })
      if (codecpar.codecId === AVCodecID.AV_CODEC_ID_PCM_F64LE
        || codecpar.codecId === AVCodecID.AV_CODEC_ID_PCM_F32LE
      ) {
        tag = 'A_PCM/FLOAT/IEEE'
      }
      if (codecpar.codecId === AVCodecID.AV_CODEC_ID_PCM_S16BE
        || codecpar.codecId === AVCodecID.AV_CODEC_ID_PCM_S24BE
        || codecpar.codecId === AVCodecID.AV_CODEC_ID_PCM_S32BE
      ) {
        tag = 'A_PCM/INT/BIG'
      }
      if (codecpar.codecId === AVCodecID.AV_CODEC_ID_PCM_U8
        || codecpar.codecId === AVCodecID.AV_CODEC_ID_PCM_S16LE
        || codecpar.codecId === AVCodecID.AV_CODEC_ID_PCM_S24LE
        || codecpar.codecId === AVCodecID.AV_CODEC_ID_PCM_S32LE
      ) {
        tag = 'A_PCM/INT/LIT'
      }
      return tag
    }

    let notSupport = false

    formatContext.streams.forEach((stream) => {
      if (stream.codecpar.codecType === AVMediaType.AVMEDIA_TYPE_ATTACHMENT
        || stream.disposition & AVDisposition.ATTACHED_PIC
      ) {
        crypto.random(this.random)
        const attachment: Attachment = {
          uid: this.randomView.getBigUint64(0),
          name: stream.metadata[AVStreamMetadataKey.TITLE],
          mime: object.reverse(MkvImageMime2CodecId)[stream.codecpar.codecId] ?? stream.metadata[AVStreamMetadataKey.MIME],
          data: {
            data: stream.attachedPic
              ? getAVPacketData(stream.attachedPic)
              : mapUint8Array(stream.codecpar.extradata, reinterpret_cast<size>(stream.codecpar.extradataSize)),
            size: static_cast<int64>(stream.codecpar.extradataSize),
            pos: -1n
          },
          description: stream.metadata[AVStreamMetadataKey.DESCRIPTION]
        }
        context.attachments.entry.push(attachment)
        const tags = {
          tag: [],
          target: {
            attachUid: attachment.uid
          }
        }
        object.each(stream.metadata, (value, key) => {
          if (key !== AVStreamMetadataKey.TITLE
            && key !== AVStreamMetadataKey.MIME
            && key !== AVStreamMetadataKey.DESCRIPTION
            && key.toLocaleLowerCase() !== 'duration'
            && is.string(value)
          ) {
            tags.tag.push({
              name: key,
              string: value
            })
          }
        })
        if (tags.tag.length) {
          context.tags.entry.push(tags)
        }
      }
      else {
        const track: TrackEntry = {}
        crypto.random(this.random)
        track.uid = this.randomView.getBigUint64(0)
        track.codecId = codecId2Tag(stream.codecpar)
        if (!track.codecId) {
          notSupport = true
          logger.error(`codecId ${stream.codecpar.codecId} not support in ${this.options.docType}`)
          return
        }
        track.number = stream.index + 1
        if (stream.codecpar.extradata) {
          track.codecPrivate = {
            data: mapUint8Array(stream.codecpar.extradata, reinterpret_cast<size>(stream.codecpar.extradataSize)).slice(),
            pos: -1n,
            size: static_cast<int64>(stream.codecpar.extradataSize)
          }
        }
        if (stream.metadata[AVStreamMetadataKey.LANGUAGE]) {
          track.language = stream.metadata[AVStreamMetadataKey.LANGUAGE]
        }
        if (stream.metadata[AVStreamMetadataKey.TITLE]) {
          track.name = stream.metadata[AVStreamMetadataKey.TITLE]
        }
        const tags = {
          tag: [],
          target: {
            trackUid: track.uid
          }
        }
        object.each(stream.metadata, (value, key) => {
          if (key !== AVStreamMetadataKey.TITLE
            && key !== AVStreamMetadataKey.LANGUAGE
            && is.string(value)
          ) {
            tags.tag.push({
              name: key,
              string: value
            })
          }
        })
        if (tags.tag.length) {
          context.tags.entry.push(tags)
        }
        switch (stream.codecpar.codecType) {
          case AVMediaType.AVMEDIA_TYPE_AUDIO: {
            track.type = MATROSKATrackType.AUDIO
            track.audio = {
              channels: stream.codecpar.chLayout.nbChannels,
              sampleRate: reinterpret_cast<float>(stream.codecpar.sampleRate),
              bitDepth: stream.codecpar.bitsPerRawSample
            }
            break
          }
          case AVMediaType.AVMEDIA_TYPE_VIDEO: {
            context.hasVideo = true
            track.type = MATROSKATrackType.VIDEO
            track.video = {
              pixelWidth: stream.codecpar.width,
              pixelHeight: stream.codecpar.height,
              color: {
                matrixCoefficients: stream.codecpar.colorSpace,
                primaries: stream.codecpar.colorPrimaries,
                transferCharacteristics: stream.codecpar.colorTrc,
                range: stream.codecpar.colorRange
              }
            }
            const result = chromaLocation2Pos(stream.codecpar.chromaLocation)
            if (result) {
              track.video.color.chromaSitingVert = (result.x >>> 7) + 1
              track.video.color.chromaSitingHorz = (result.y >>> 7) + 1
            }
            if (stream.codecpar.codecId === AVCodecID.AV_CODEC_ID_H264
              || stream.codecpar.codecId === AVCodecID.AV_CODEC_ID_HEVC
              || stream.codecpar.codecId === AVCodecID.AV_CODEC_ID_VVC
            ) {
              if (track.codecPrivate) {
                if (naluUtil.isAnnexb(track.codecPrivate.data)) {
                  if (stream.codecpar.codecId === AVCodecID.AV_CODEC_ID_H264) {
                    track.codecPrivate.data = h264.annexbExtradata2AvccExtradata(track.codecPrivate.data)
                  }
                  else if (stream.codecpar.codecId === AVCodecID.AV_CODEC_ID_HEVC) {
                    track.codecPrivate.data = hevc.annexbExtradata2AvccExtradata(track.codecPrivate.data)
                  }
                  else if (stream.codecpar.codecId === AVCodecID.AV_CODEC_ID_VVC) {
                    track.codecPrivate.data = vvc.annexbExtradata2AvccExtradata(track.codecPrivate.data)
                  }
                  track.codecPrivate.size = static_cast<int64>(track.codecPrivate.data.length)
                }
              }
              this.annexb2AvccFilter = new Annexb2AvccFilter()
              this.annexb2AvccFilter.init(addressof(stream.codecpar), addressof(stream.timeBase))
            }
            break
          }
          case AVMediaType.AVMEDIA_TYPE_SUBTITLE: {
            track.type = MATROSKATrackType.SUBTITLE
            break
          }
        }
        track.lastPts = 0n
        stream.privData = track

        if (stream.codecpar.codecId === AVCodecID.AV_CODEC_ID_SSA
          || stream.codecpar.codecId === AVCodecID.AV_CODEC_ID_ASS
        ) {
          if (!track.codecPrivate) {
            logger.fatal('ass need extradata')
          }
          track.ass = {
            order: 1,
            popIndex: []
          }
          const header = text.decode(track.codecPrivate.data)
          let lines = header.split(/\r?\n/)
          let format: string
          for (let i = 0; i < lines.length; i++) {
            if (lines[i].trim() === '[Events]') {
              if (lines[i + 1] && /^Format:/.test(lines[i + 1])) {
                format = lines[i + 1]
              }
              lines = lines.slice(0, i)
              break
            }
          }
          if (format) {
            format = format.replace(/^Format:/, '')
            const list = format.split(',').map((v) => v.trim())
            if (list.indexOf('Start') > -1) {
              track.ass.popIndex.push(list.indexOf('Start'))
            }
            if (list.indexOf('End') > -1) {
              track.ass.popIndex.push(list.indexOf('End'))
            }
            track.ass.popIndex.sort((a, b) => b - a)
          }
        }
        context.tracks.entry.push(track)
      }
    })

    formatContext.chapters.forEach((chapter) => {
      const atom: ChapterAtom = {
        uid: chapter.id,
        start: chapter.start,
        end: chapter.end,
      }
      if (chapter.metadata) {
        atom.display = {}

        const tags = {
          tag: [],
          target: {
            chapterUid: chapter.id
          }
        }
        object.each(chapter.metadata, (value, key) => {
          if (key === AVStreamMetadataKey.TITLE) {
            atom.display[AVStreamMetadataKey.TITLE] = chapter.metadata[AVStreamMetadataKey.TITLE]
          }
          else if (key === AVStreamMetadataKey.LANGUAGE) {
            atom.display[AVStreamMetadataKey.LANGUAGE] = chapter.metadata[AVStreamMetadataKey.LANGUAGE]
          }
          else if (is.string(value)) {
            tags.tag.push({
              name: key,
              string: value
            })
          }
        })
        if (tags.tag.length) {
          context.tags.entry.push(tags)
        }
        if (!object.keys(atom.display).length) {
          delete atom.display
        }
      }
      context.chapters.entry.push({
        atom: [atom]
      })
    })

    const tags = {
      tag: []
    }
    object.each(formatContext.metadata, (value, key) => {
      if (is.string(value)
        && key.toLocaleLowerCase() !== AVStreamMetadataKey.ENCODER
        && key.toLocaleLowerCase() !== AVStreamMetadataKey.CREATION_TIME
      ) {
        tags.tag.push({
          name: key,
          string: value
        })
      }
    })
    if (tags.tag.length) {
      context.tags.entry.push(tags)
    }

    if (notSupport) {
      return errorType.CODEC_NOT_SUPPORT
    }

    return 0
  }

  public async destroy(formatContext: AVOFormatContext) {
    if (this.annexb2AvccFilter) {
      this.annexb2AvccFilter.destroy()
      this.annexb2AvccFilter = null
    }
    if (this.avpacket) {
      destroyAVPacket(this.avpacket)
      this.avpacket = nullptr
    }
  }

  public writeHeader(formatContext: AVOFormatContext): number {
    omatroska.writeHeader(formatContext.ioWriter, this.context, this.context.header)

    omatroska.writeEbmlId(formatContext.ioWriter, EBMLId.SEGMENT)

    const now = formatContext.ioWriter.getPos()
    omatroska.writeEbmlLengthUnknown(formatContext.ioWriter, 8)
    this.context.elePositionInfos.push({
      pos: now,
      length: 0,
      bytes: 8
    })

    this.context.segmentStart = formatContext.ioWriter.getPos()
    // SeekHead 占位
    formatContext.ioWriter.skip(96)
    this.context.seekHeadEnd = formatContext.ioWriter.getPos()

    return 0
  }

  private processAss(buffer: Uint8Array, stream: AVStream) {
    const track = stream.privData as TrackEntry
    let context = text.decode(buffer)
    if (/^Dialogue:/.test(context)) {
      context = context.replace(/^Dialogue:/, '')
    }
    const list = context.split(',').map((v) => v.trim())
    if (track.ass.popIndex?.length) {
      track.ass.popIndex.forEach((index) => {
        list.splice(index, 1)
      })
    }
    list.unshift(toString(track.ass.order++))
    return text.encode(list.join(','))
  }

  private writeBlock(stream: AVStream, avpacket: pointer<AVPacket>, id: EBMLId.SIMPLE_BLOCK | EBMLId.BLOCK = EBMLId.SIMPLE_BLOCK) {
    const track = stream.privData as TrackEntry
    omatroska.writeEbmlId(this.context.eleWriter, id)
    if ((stream.codecpar.codecId === AVCodecID.AV_CODEC_ID_H264
        || stream.codecpar.codecId === AVCodecID.AV_CODEC_ID_HEVC
        || stream.codecpar.codecId === AVCodecID.AV_CODEC_ID_VVC
    ) && (avpacket.flags & AVPacketFlags.AV_PKT_FLAG_H26X_ANNEXB)
    ) {
      this.annexb2AvccFilter.sendAVPacket(avpacket)
      this.annexb2AvccFilter.receiveAVPacket(this.avpacket)
      avpacket = this.avpacket
    }
    let buffer = getAVPacketData(avpacket)
    if (stream.codecpar.codecId === AVCodecID.AV_CODEC_ID_ASS
      || stream.codecpar.codecId === AVCodecID.AV_CODEC_ID_SSA
    ) {
      buffer = this.processAss(buffer, stream)
    }
    omatroska.writeEbmlLength(this.context.eleWriter, omatroska.ebmlLengthSize(track.number) + 2 + 1 + buffer.length)
    omatroska.writeEbmlNum(this.context.eleWriter, track.number, omatroska.ebmlLengthSize(track.number))
    const pts = avRescaleQ2(avpacket.pts, addressof(avpacket.timeBase), AV_MILLI_TIME_BASE_Q)

    this.context.eleWriter.writeInt16(static_cast<int32>(pts - this.context.currentCluster.timeCode))

    if (avpacket.flags & AVPacketFlags.AV_PKT_FLAG_KEY || stream.codecpar.codecType !== AVMediaType.AVMEDIA_TYPE_VIDEO) {
      this.context.eleWriter.writeUint8(0x80)
    }
    else {
      this.context.eleWriter.writeUint8(0x00)
    }
    if (!track.codecPrivate) {
      let element = getAVPacketSideData(avpacket, AVPacketSideDataType.AV_PKT_DATA_NEW_EXTRADATA)
      if (element) {
        track.codecPrivate = {
          data: mapUint8Array(element.data, element.size).slice(),
          pos: -1n,
          size: static_cast<int64>(element.size)
        }
      }
    }
    this.context.eleWriter.writeBuffer(buffer)
  }

  private writeBlockGroup(stream: AVStream, avpacket: pointer<AVPacket>) {
    omatroska.writeEleData(this.context.eleWriter, this.context, EBMLId.BLOCK_GROUP, (eleWriter) => {
      if (avpacket.duration > 0) {
        omatroska.writeEbmlUint(eleWriter, EBMLId.BLOCK_DURATION, avRescaleQ2(avpacket.duration, addressof(avpacket.timeBase), AV_MILLI_TIME_BASE_Q))
      }
      const additions: {
        additionalId: int32
        buffer: Uint8ArrayInterface
      }[] = []
      let vtt = []
      for (let i = 0; i < avpacket.sideDataElems; i++) {
        if (avpacket.sideData[i].type === AVPacketSideDataType.AV_PKT_DATA_MATROSKA_BLOCKADDITIONAL) {
          additions.push({
            additionalId: static_cast<int32>(intread.rb64(avpacket.sideData[i].data)),
            buffer: mapUint8Array(avpacket.sideData[i].data + 8, avpacket.sideData[i].size - 8)
          })
        }
        else if (avpacket.sideData[i].type === AVPacketSideDataType.AV_PKT_DATA_WEBVTT_IDENTIFIER) {
          vtt.push(mapUint8Array(avpacket.sideData[i].data, avpacket.sideData[i].size), [0x0a])
        }
        else if (avpacket.sideData[i].type === AVPacketSideDataType.AV_PKT_DATA_WEBVTT_SETTINGS) {
          vtt.push(mapUint8Array(avpacket.sideData[i].data, avpacket.sideData[i].size), [0x0a])
        }
      }
      if (stream.codecpar.codecId === AVCodecID.AV_CODEC_ID_WEBVTT && vtt.length) {
        additions.push({
          additionalId: MATROSKABlockAddIdType.OPAQUE,
          buffer: concatTypeArray(Uint8Array, vtt)
        })
      }
      if (additions.length) {
        omatroska.writeEleData(this.context.eleWriter, this.context, EBMLId.BLOCK_ADDITIONS, (eleWriter) => {
          omatroska.writeEleData(eleWriter, this.context, EBMLId.BLOCK_MORE, (eleWriter) => {
            additions.forEach((addition) => {
              omatroska.writeEbmlUint(eleWriter, EBMLId.BLOCK_ADD_ID, addition.additionalId)
              omatroska.writeEbmlBuffer(eleWriter, EBMLId.BLOCK_ADDITIONS, addition.buffer)
            })
          })
        })
      }
      if (stream.codecpar.codecType === AVMediaType.AVMEDIA_TYPE_VIDEO
        && !(avpacket.flags & AVPacketFlags.AV_PKT_FLAG_KEY)
      ) {
        const track = stream.privData as TrackEntry
        omatroska.writeEbmlSint(eleWriter, EBMLId.BLOCK_REFERENCE, track.lastPts - avpacket.pts)
      }
      this.writeBlock(stream, avpacket, EBMLId.BLOCK)
    })
  }

  private writeCluster(formatContext: AVOFormatContext) {
    if (this.context.currentCluster.pos === -1n) {
      return
    }

    formatContext.ioWriter.flush()
    this.context.eleWriter.flush()

    let block = concatTypeArray(Uint8Array, this.context.eleCaches)

    if (!block.length) {
      return
    }

    this.context.eleCaches.length = 0
    omatroska.writeEbmlUint(this.context.eleWriter, EBMLId.CLUSTER_TIME_CODE, this.context.currentCluster.timeCode)
    this.context.eleWriter.flush()
    block = concatTypeArray(Uint8Array, [...this.context.eleCaches, block])


    omatroska.writeEbmlId(formatContext.ioWriter, EBMLId.CLUSTER)
    omatroska.writeEbmlLength(formatContext.ioWriter, block.length)
    formatContext.ioWriter.writeBuffer(block)

    formatContext.ioWriter.flush()
    this.context.eleCaches.length = 0
  }

  public writeAVPacket(formatContext: AVOFormatContext, avpacket: pointer<AVPacket>): number {

    if (!avpacket.size) {
      logger.warn(`packet\'s size is 0: ${avpacket.streamIndex}, ignore it`)
      return 0
    }

    const stream = formatContext.getStreamByIndex(avpacket.streamIndex)

    if (!stream || (stream.disposition & AVDisposition.ATTACHED_PIC)) {
      logger.warn(`can not found the stream width the avpacket\'s streamIndex: ${avpacket.streamIndex}, ignore it`)
      return
    }

    const track = stream.privData as TrackEntry

    const pts = avRescaleQ2(avpacket.pts !== NOPTS_VALUE_BIGINT ? avpacket.pts : avpacket.dts, addressof(avpacket.timeBase), AV_MILLI_TIME_BASE_Q)

    if (!track.maxPts || track.maxPts < pts) {
      track.maxPts = pts
      track.duration = pts
      if (avpacket.duration !== NOPTS_VALUE_BIGINT) {
        track.duration += avRescaleQ2(avpacket.duration, addressof(avpacket.timeBase), AV_MILLI_TIME_BASE_Q)
      }
    }

    if (this.options.isLive
      || (avpacket.flags & AVPacketFlags.AV_PKT_FLAG_KEY)
        && (
          stream.codecpar.codecType === AVMediaType.AVMEDIA_TYPE_VIDEO
          || !this.context.hasVideo
            && (pts - this.context.currentCluster.timeCode > 5000n)
        )
    ) {
      this.writeCluster(formatContext)
      this.context.currentCluster.timeCode = pts
      this.context.currentCluster.pos = formatContext.ioWriter.getPos() - this.context.segmentStart
      this.context.cues.entry.push({
        time: this.context.currentCluster.timeCode,
        pos: [{
          pos: this.context.currentCluster.pos,
          track: track.number
        }]
      })
    }

    if (avpacket.duration > 0
      || hasAVPacketSideData(avpacket, AVPacketSideDataType.AV_PKT_DATA_MATROSKA_BLOCKADDITIONAL)
      || hasAVPacketSideData(avpacket, AVPacketSideDataType.AV_PKT_DATA_WEBVTT_IDENTIFIER)
      || hasAVPacketSideData(avpacket, AVPacketSideDataType.AV_PKT_DATA_WEBVTT_SETTINGS)
    ) {
      this.writeBlockGroup(stream, avpacket)
    }
    else {
      this.writeBlock(stream, avpacket)
    }

    track.lastPts = avpacket.pts

    return 0
  }

  public writeTrailer(formatContext: AVOFormatContext): number {

    this.writeCluster(formatContext)

    formatContext.streams.forEach((stream) => {
      const track = stream.privData as TrackEntry

      if (!this.options.isLive && track?.duration) {
        const duration = track.duration
        this.context.info.duration = Math.max(
          reinterpret_cast<float>(static_cast<int32>(duration)),
          this.context.info.duration
        )
        let tags = this.context.tags.entry.find((tags) => {
          return tags.target?.trackUid === track.uid
        })
        if (!tags) {
          tags = {
            tag: [],
            target: {
              trackUid: track.uid
            }
          }
          this.context.tags.entry.push(tags)
        }
        tags.tag.push({
          name: 'DURATION',
          string: formatTimestamp(duration)
        })
      }
    })

    formatContext.ioWriter.flush()
    this.context.eleWriter.flush()
    this.context.eleCaches.length = 0

    this.context.eleWriter.reset()

    const now = formatContext.ioWriter.getPos()
    let segmentLength = now - this.context.segmentStart

    this.context.seekHead.entry.push({
      id: EBMLId.INFO,
      pos: this.context.eleWriter.getPos() + this.context.seekHeadEnd - this.context.segmentStart
    })
    omatroska.writeInfo(this.context.eleWriter, this.context, this.context.info)
    this.context.seekHead.entry.push({
      id: EBMLId.TRACKS,
      pos: this.context.eleWriter.getPos() + this.context.seekHeadEnd - this.context.segmentStart
    })
    omatroska.writeTracks(this.context.eleWriter, this.context, this.context.tracks)
    this.context.seekHead.entry.push({
      id: EBMLId.TAGS,
      pos: this.context.eleWriter.getPos() + this.context.seekHeadEnd - this.context.segmentStart
    })
    omatroska.writeTags(this.context.eleWriter, this.context, this.context.tags)
    this.context.eleWriter.flush()

    const buffer = concatTypeArray(Uint8Array, this.context.eleCaches)
    formatContext.ioWriter.onFlush(buffer, this.context.seekHeadEnd)

    segmentLength += static_cast<int64>(buffer.length)

    this.context.cues.entry.forEach((cue) => {
      cue.pos.forEach((item) => {
        item.pos += static_cast<int64>(buffer.length)
      })
    })

    if (this.context.cues.entry.length) {
      this.context.seekHead.entry.push({
        id: EBMLId.CUES,
        pos: formatContext.ioWriter.getPos() - this.context.segmentStart + static_cast<int64>(buffer.length)
      })
      omatroska.writeCues(formatContext.ioWriter, this.context, this.context.cues)
    }
    if (this.context.attachments.entry.length) {
      this.context.seekHead.entry.push({
        id: EBMLId.ATTACHMENTS,
        pos: formatContext.ioWriter.getPos() - this.context.segmentStart + static_cast<int64>(buffer.length)
      })
      omatroska.writeAttachments(formatContext.ioWriter, this.context, this.context.attachments)
    }

    formatContext.ioWriter.flush()
    segmentLength += formatContext.ioWriter.getPos() - now

    formatContext.ioWriter.seek(this.context.segmentStart)
    omatroska.writeSeekHeader(formatContext.ioWriter, this.context, this.context.seekHead)
    const seekHeadLen = formatContext.ioWriter.getPos() - this.context.segmentStart
    omatroska.writeEbmlId(formatContext.ioWriter, EBMLId.VOID)
    omatroska.writeEbmlLength(formatContext.ioWriter, this.context.seekHeadEnd - this.context.segmentStart - seekHeadLen - 2n, 1)
    formatContext.ioWriter.flush()

    this.context.elePositionInfos[0].length = segmentLength
    omatroska.updatePositionSize(formatContext.ioWriter, this.context)

    this.context.eleCaches.length = 0

    return 0
  }

  public flush(formatContext: AVOFormatContext): number {
    formatContext.ioWriter.flush()
    this.context.currentCluster.timeCode = -1n
    this.context.currentCluster.pos = -1n
    return 0
  }

  public getCapabilities() {
    return this.options.docType === 'webm' ? OMatroskaFormat.CapabilitiesWebm : OMatroskaFormat.Capabilities
  }

  static Capabilities: AVCodecID[] = [
    AVCodecID.AV_CODEC_ID_VORBIS,
    AVCodecID.AV_CODEC_ID_OPUS,
    AVCodecID.AV_CODEC_ID_AAC,
    AVCodecID.AV_CODEC_ID_MP3,
    AVCodecID.AV_CODEC_ID_FLAC,
    AVCodecID.AV_CODEC_ID_ALAC,
    AVCodecID.AV_CODEC_ID_DTS,
    AVCodecID.AV_CODEC_ID_EAC3,
    AVCodecID.AV_CODEC_ID_AC3,
    AVCodecID.AV_CODEC_ID_PCM_F32LE,
    AVCodecID.AV_CODEC_ID_PCM_S16BE,
    AVCodecID.AV_CODEC_ID_PCM_S16LE,

    AVCodecID.AV_CODEC_ID_VP8,
    AVCodecID.AV_CODEC_ID_VP9,
    AVCodecID.AV_CODEC_ID_AV1,
    AVCodecID.AV_CODEC_ID_H264,
    AVCodecID.AV_CODEC_ID_HEVC,
    AVCodecID.AV_CODEC_ID_VVC,
    AVCodecID.AV_CODEC_ID_MPEG4,
    AVCodecID.AV_CODEC_ID_THEORA,

    AVCodecID.AV_CODEC_ID_WEBVTT,
    AVCodecID.AV_CODEC_ID_SSA,
    AVCodecID.AV_CODEC_ID_ASS,
    AVCodecID.AV_CODEC_ID_TEXT,
    AVCodecID.AV_CODEC_ID_SUBRIP
  ]

  static CapabilitiesWebm: AVCodecID[] = [
    AVCodecID.AV_CODEC_ID_VORBIS,
    AVCodecID.AV_CODEC_ID_OPUS,

    AVCodecID.AV_CODEC_ID_VP8,
    AVCodecID.AV_CODEC_ID_VP9,
    AVCodecID.AV_CODEC_ID_AV1,

    AVCodecID.AV_CODEC_ID_WEBVTT
  ]
}
