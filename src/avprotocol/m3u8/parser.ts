/**
 * from https://github.com/kuu/hls-parser/blob/master/parse.ts
 * MIT license 
 * 
 */

import * as utils from './utils'
import {
  Rendition,
  Variant,
  SessionData,
  Key,
  MediaInitializationSection,
  Byterange,
  DateRange,
  SpliceInfo,
  MasterPlaylist,
  MediaPlaylist,
  Segment,
  PartialSegment,
  PrefetchSegment,
  RenditionReport
} from './types'
import { Data } from 'common/types/type'

import * as logger from 'common/util/logger'

function unquote(str: string | undefined) {
  return utils.trim(str, '"')
}

type TagCategory = 'Basic' | 'Segment' | 'MasterPlaylist' | 'MediaPlaylist' | 'MediaorMasterPlaylist' | 'Unknown'

function getTagCategory(tagName: string): TagCategory {
  switch (tagName) {
    case 'EXTM3U':
    case 'EXT-X-VERSION':
      return 'Basic'
    case 'EXTINF':
    case 'EXT-X-BYTERANGE':
    case 'EXT-X-DISCONTINUITY':
    case 'EXT-X-PREFETCH-DISCONTINUITY':
    case 'EXT-X-KEY':
    case 'EXT-X-MAP':
    case 'EXT-X-PROGRAM-DATE-TIME':
    case 'EXT-X-DATERANGE':
    case 'EXT-X-CUE-OUT':
    case 'EXT-X-CUE-IN':
    case 'EXT-X-CUE-OUT-CONT':
    case 'EXT-X-CUE':
    case 'EXT-OATCLS-SCTE35':
    case 'EXT-X-ASSET':
    case 'EXT-X-SCTE35':
    case 'EXT-X-PART':
    case 'EXT-X-PRELOAD-HINT':
      return 'Segment'
    case 'EXT-X-TARGETDURATION':
    case 'EXT-X-MEDIA-SEQUENCE':
    case 'EXT-X-DISCONTINUITY-SEQUENCE':
    case 'EXT-X-ENDLIST':
    case 'EXT-X-PLAYLIST-TYPE':
    case 'EXT-X-I-FRAMES-ONLY':
    case 'EXT-X-SERVER-CONTROL':
    case 'EXT-X-PART-INF':
    case 'EXT-X-PREFETCH':
    case 'EXT-X-RENDITION-REPORT':
    case 'EXT-X-SKIP':
      return 'MediaPlaylist'
    case 'EXT-X-MEDIA':
    case 'EXT-X-STREAM-INF':
    case 'EXT-X-I-FRAME-STREAM-INF':
    case 'EXT-X-SESSION-DATA':
    case 'EXT-X-SESSION-KEY':
      return 'MasterPlaylist'
    case 'EXT-X-INDEPENDENT-SEGMENTS':
    case 'EXT-X-START':
      return 'MediaorMasterPlaylist'
    default:
      return 'Unknown'
  }
}

function parseEXTINF(param: string) {
  const pair = utils.splitAt(param, ',') as [string, string]
  return {duration: utils.toNumber(pair[0]), title: decodeURIComponent(escape(pair[1]))}
}

function parseBYTERANGE(param: string): Byterange {
  const pair = utils.splitAt(param, '@')
  return {length: utils.toNumber(pair[0]), offset: pair[1] ? utils.toNumber(pair[1]) : -1}
}

function parseResolution(str: string) {
  const pair = utils.splitAt(str, 'x') as [string, string]
  return {width: utils.toNumber(pair[0]), height: utils.toNumber(pair[1])}
}

function parseAllowedCpc(str: string) {
  const message = 'ALLOWED-CPC: Each entry must consit of KEYFORMAT and Content Protection Configuration'
  const list = str.split(',')
  if (list.length === 0) {
    logger.error(message)
  }
  const allowedCpcList: {format: string, cpcList: string[]}[] = []
  for (const item of list) {
    const [format, cpcText] = utils.splitAt(item, ':')
    if (!format || !cpcText) {
      logger.error(message)
      continue
    }
    allowedCpcList.push({format, cpcList: cpcText.split('/')})
  }
  return allowedCpcList
}

function parseIV(str: string): Uint8Array {
  const iv = utils.hexToByteSequence(str)
  if (iv.length !== 16) {
    logger.error('IV must be a 128-bit unsigned integer')
  }
  return iv
}

function parseUserAttribute(str: string) {
  if (str.startsWith('"')) {
    return unquote(str)
  }
  if (str.startsWith('0x') || str.startsWith('0X')) {
    return utils.hexToByteSequence(str)
  }
  return utils.toNumber(str)
}

function setCompatibleVersionOfKey(params: Record<string, any>, attributes: Record<string, any>) {
  if (attributes['IV'] && params.compatibleVersion < 2) {
    params.compatibleVersion = 2
  }
  if ((attributes['KEYFORMAT'] || attributes['KEYFORMATVERSIONS']) && params.compatibleVersion < 5) {
    params.compatibleVersion = 5
  }
}

function parseAttributeList(param: string) {
  const attributes = {}
  for (const item of utils.splitByCommaWithPreservingQuotes(param)) {
    const [key, value] = utils.splitAt(item, '=')
    const val = unquote(value)!
    switch (key) {
      case 'URI':
        attributes[key] = val
        break
      case 'START-DATE':
      case 'END-DATE':
        attributes[key] = new Date(val)
        break
      case 'IV':
        attributes[key] = parseIV(val)
        break
      case 'BYTERANGE':
        attributes[key] = parseBYTERANGE(val)
        break
      case 'RESOLUTION':
        attributes[key] = parseResolution(val)
        break
      case 'ALLOWED-CPC':
        attributes[key] = parseAllowedCpc(val)
        break
      case 'END-ON-NEXT':
      case 'DEFAULT':
      case 'AUTOSELECT':
      case 'FORCED':
      case 'PRECISE':
      case 'CAN-BLOCK-RELOAD':
      case 'INDEPENDENT':
      case 'GAP':
        attributes[key] = val === 'YES'
        break
      case 'DURATION':
      case 'PLANNED-DURATION':
      case 'BANDWIDTH':
      case 'AVERAGE-BANDWIDTH':
      case 'FRAME-RATE':
      case 'TIME-OFFSET':
      case 'CAN-SKIP-UNTIL':
      case 'HOLD-BACK':
      case 'PART-HOLD-BACK':
      case 'PART-TARGET':
      case 'BYTERANGE-START':
      case 'BYTERANGE-LENGTH':
      case 'LAST-MSN':
      case 'LAST-PART':
      case 'SKIPPED-SEGMENTS':
      case 'SCORE':
      case 'PROGRAM-ID':
        attributes[key] = utils.toNumber(val)
        break
      default:
        if (key.startsWith('SCTE35-')) {
          attributes[key] = utils.hexToByteSequence(val)
        }
        else if (key.startsWith('X-')) {
          attributes[key] = parseUserAttribute(value!)
        }
        else {
          if (key === 'VIDEO-RANGE' && val !== 'SDR' && val !== 'HLG' && val !== 'PQ') {
            logger.fatal(`VIDEO-RANGE: unknown value "${val}"`)
          }
          attributes[key] = val
        }
    }
  }
  return attributes
}

function parseTagParam(name: string, param: string) {
  switch (name) {
    case 'EXTM3U':
    case 'EXT-X-DISCONTINUITY':
    case 'EXT-X-ENDLIST':
    case 'EXT-X-I-FRAMES-ONLY':
    case 'EXT-X-INDEPENDENT-SEGMENTS':
    case 'EXT-X-CUE-IN':
      return [null, null]
    case 'EXT-X-VERSION':
    case 'EXT-X-TARGETDURATION':
    case 'EXT-X-MEDIA-SEQUENCE':
    case 'EXT-X-DISCONTINUITY-SEQUENCE':
      return [utils.toNumber(param), null]
    case 'EXT-X-CUE-OUT':
      // For backwards compatibility: attributes list is optional,
      // if only a number is found, use it as the duration
      if (!Number.isNaN(Number(param))) {
        return [utils.toNumber(param), null]
      }
      // If attributes are found, parse them out (i.e. DURATION)
      return [null, parseAttributeList(param)]
    case 'EXT-X-KEY':
    case 'EXT-X-MAP':
    case 'EXT-X-DATERANGE':
    case 'EXT-X-MEDIA':
    case 'EXT-X-STREAM-INF':
    case 'EXT-X-I-FRAME-STREAM-INF':
    case 'EXT-X-SESSION-DATA':
    case 'EXT-X-SESSION-KEY':
    case 'EXT-X-START':
    case 'EXT-X-SERVER-CONTROL':
    case 'EXT-X-PART-INF':
    case 'EXT-X-PART':
    case 'EXT-X-PRELOAD-HINT':
    case 'EXT-X-RENDITION-REPORT':
    case 'EXT-X-SKIP':
      return [null, parseAttributeList(param)]
    case 'EXTINF':
      return [parseEXTINF(param), null]
    case 'EXT-X-BYTERANGE':
      return [parseBYTERANGE(param), null]
    case 'EXT-X-PROGRAM-DATE-TIME':
      return [new Date(param), null]
    case 'EXT-X-PLAYLIST-TYPE':
      // <EVENT|VOD>
      return [param, null]
    default:
      // Unknown tag
      return [param, null]
  }
}

function splitTag(line: string): [string, string | null] {
  const index = line.indexOf(':')
  if (index === -1) {
    return [line.slice(1).trim(), null]
  }
  return [line.slice(1, index).trim(), line.slice(index + 1).trim()]
}

function parseRendition({attributes}: Tag): Rendition {
  const rendition = new Rendition({
    type: attributes['TYPE'],
    uri: attributes['URI'],
    groupId: attributes['GROUP-ID'],
    language: attributes['LANGUAGE'],
    assocLanguage: attributes['ASSOC-LANGUAGE'],
    name: attributes['NAME'],
    isDefault: attributes['DEFAULT'],
    autoselect: attributes['AUTOSELECT'],
    forced: attributes['FORCED'],
    instreamId: attributes['INSTREAM-ID'],
    characteristics: attributes['CHARACTERISTICS'],
    channels: attributes['CHANNELS']
  })
  return rendition
}

function checkRedundantRendition(renditions, rendition) {
  let defaultFound = false
  for (const item of renditions) {
    if (item.name === rendition.name) {
      return 'All EXT-X-MEDIA tags in the same Group MUST have different NAME attributes.'
    }
    if (item.isDefault) {
      defaultFound = true
    }
  }
  if (defaultFound && rendition.isDefault) {
    return 'EXT-X-MEDIA A Group MUST NOT have more than one member with a DEFAULT attribute of YES.'
  }
  return ''
}

function addRendition(variant: Data, line: Tag, type: string) {
  const rendition = parseRendition(line)
  const renditions = variant[utils.camelify(type)]
  const errorMessage = checkRedundantRendition(renditions, rendition)
  if (errorMessage) {
    logger.fatal(errorMessage)
  }
  renditions.push(rendition)
  if (rendition.isDefault) {
    variant.currentRenditions[utils.camelify(type)] = renditions.length - 1
  }
}

function matchTypes(attrs: Data, variant: Data, params: Data) {
  for (const type of ['AUDIO', 'VIDEO', 'SUBTITLES', 'CLOSED-CAPTIONS']) {
    if (type === 'CLOSED-CAPTIONS' && attrs[type] === 'NONE') {
      params.isClosedCaptionsNone = true
      variant.closedCaptions = []
    }
    else if (attrs[type] && !variant[utils.camelify(type)].some((item) => item.groupId === attrs[type])) {
      logger.fatal(`${type} attribute MUST match the value of the GROUP-ID attribute of an EXT-X-MEDIA tag whose TYPE attribute is ${type}.`)
    }
  }
}

function parseVariant(lines: Tag[], variantAttrs: Data, uri: Tag, iFrameOnly: boolean, params: Data) {
  const variant = new Variant({
    uri,
    bandwidth: variantAttrs['BANDWIDTH'],
    averageBandwidth: variantAttrs['AVERAGE-BANDWIDTH'],
    score: variantAttrs['SCORE'],
    codecs: variantAttrs['CODECS'],
    resolution: variantAttrs['RESOLUTION'],
    frameRate: variantAttrs['FRAME-RATE'],
    hdcpLevel: variantAttrs['HDCP-LEVEL'],
    allowedCpc: variantAttrs['ALLOWED-CPC'],
    videoRange: variantAttrs['VIDEO-RANGE'],
    stableVariantId: variantAttrs['STABLE-VARIANT-ID'],
    programId: variantAttrs['PROGRAM-ID']
  })
  for (const line of lines) {
    if (line.name === 'EXT-X-MEDIA') {
      const renditionAttrs = line.attributes
      const renditionType = renditionAttrs['TYPE']
      if (!renditionType || !renditionAttrs['GROUP-ID']) {
        logger.fatal('EXT-X-MEDIA TYPE attribute is REQUIRED.')
      }
      if (variantAttrs[renditionType] === renditionAttrs['GROUP-ID']) {
        addRendition(variant, line, renditionType)
        if (renditionType === 'CLOSED-CAPTIONS') {
          for (const {instreamId} of variant.closedCaptions) {
            if (instreamId && instreamId.startsWith('SERVICE') && params.compatibleVersion < 7) {
              params.compatibleVersion = 7
              break
            }
          }
        }
      }
    }
  }
  matchTypes(variantAttrs, variant, params)
  variant.isIFrameOnly = iFrameOnly
  return variant
}

function sameKey(key1: Key, key2: Key) {
  if (key1.method !== key2.method) {
    return false
  }
  if (key1.uri !== key2.uri) {
    return false
  }
  if (key1.iv) {
    if (!key2.iv) {
      return false
    }
    if (key1.iv.length !== key2.iv.length) {
      return false
    }
    for (let i = 0; i < key1.iv.length; i++) {
      if (key1.iv[i] !== key2.iv[i]) {
        return false
      }
    }
  }
  else if (key2.iv) {
    return false
  }
  if (key1.format !== key2.format) {
    return false
  }
  if (key1.formatVersion !== key2.formatVersion) {
    return false
  }
  return true
}

function parseMasterPlaylist(lines: Line[], params: Record<string, any>): MasterPlaylist {
  const playlist = new MasterPlaylist()
  let variantIsScored = false
  for (const [index, {name, value, attributes}] of (lines as Tag[]).entries()) {
    if (name === 'EXT-X-VERSION') {
      playlist.version = value
    }
    else if (name === 'EXT-X-STREAM-INF') {
      const uri = lines[index + 1]
      if (typeof uri !== 'string' || uri.startsWith('#EXT')) {
        logger.fatal('EXT-X-STREAM-INF must be followed by a URI line')
      }
      const variant = parseVariant(lines as Tag[], attributes, uri as Tag, false, params)
      if (variant) {
        if (typeof variant.score === 'number') {
          variantIsScored = true
          if (variant.score < 0) {
            logger.fatal('SCORE attribute on EXT-X-STREAM-INF must be positive decimal-floating-point number.')
          }
        }
        playlist.variants.push(variant)
      }
    }
    else if (name === 'EXT-X-I-FRAME-STREAM-INF') {
      const variant = parseVariant(lines as Tag[], attributes, attributes.URI, true, params)
      if (variant) {
        playlist.variants.push(variant)
      }
    }
    else if (name === 'EXT-X-SESSION-DATA') {
      const sessionData = new SessionData({
        id: attributes['DATA-ID'],
        value: attributes['VALUE'],
        uri: attributes['URI'],
        language: attributes['LANGUAGE']
      })
      if (playlist.sessionDataList.some((item) => item.id === sessionData.id && item.language === sessionData.language)) {
        logger.fatal('A Playlist MUST NOT contain more than one EXT-X-SESSION-DATA tag with the same DATA-ID attribute and the same LANGUAGE attribute.')
      }
      playlist.sessionDataList.push(sessionData)
    }
    else if (name === 'EXT-X-SESSION-KEY') {
      if (attributes['METHOD'] === 'NONE') {
        logger.fatal('EXT-X-SESSION-KEY: The value of the METHOD attribute MUST NOT be NONE')
      }
      const sessionKey = new Key({
        method: attributes['METHOD'],
        uri: attributes['URI'],
        iv: attributes['IV'],
        format: attributes['KEYFORMAT'],
        formatVersion: attributes['KEYFORMATVERSIONS']
      })
      if (playlist.sessionKeyList.some((item) => sameKey(item, sessionKey))) {
        logger.fatal('A Master Playlist MUST NOT contain more than one EXT-X-SESSION-KEY tag with the same METHOD, URI, IV, KEYFORMAT, and KEYFORMATVERSIONS attribute values.')
      }
      setCompatibleVersionOfKey(params, attributes)
      playlist.sessionKeyList.push(sessionKey)
    }
    else if (name === 'EXT-X-INDEPENDENT-SEGMENTS') {
      if (playlist.independentSegments) {
        logger.fatal('EXT-X-INDEPENDENT-SEGMENTS tag MUST NOT appear more than once in a Playlist')
      }
      playlist.independentSegments = true
    }
    else if (name === 'EXT-X-START') {
      if (playlist.start) {
        logger.fatal('EXT-X-START tag MUST NOT appear more than once in a Playlist')
      }
      if (typeof attributes['TIME-OFFSET'] !== 'number') {
        logger.fatal('EXT-X-START: TIME-OFFSET attribute is REQUIRED')
      }
      playlist.start = {offset: attributes['TIME-OFFSET'], precise: attributes['PRECISE'] || false}
    }
  }
  if (variantIsScored) {
    for (const variant of playlist.variants) {
      if (typeof variant.score !== 'number') {
        logger.fatal('If any Variant Stream contains the SCORE attribute, then all Variant Streams in the Master Playlist SHOULD have a SCORE attribute')
      }
    }
  }
  if (params.isClosedCaptionsNone) {
    for (const variant of playlist.variants) {
      if (variant.closedCaptions.length > 0) {
        logger.fatal('If there is a variant with CLOSED-CAPTIONS attribute of NONE, all EXT-X-STREAM-INF tags MUST have this attribute with a value of NONE')
      }
    }
  }
  return playlist
}

function parseSegment(
  lines: Line[],
  uri: string,
  start: number,
  end: number,
  mediaSequenceNumber: number,
  discontinuitySequence: number,
  params: Record<string, any>
) {
  const segment = new Segment({uri, mediaSequenceNumber, discontinuitySequence})
  let mapHint = false
  let partHint = false
  for (let i = start; i <= end; i++) {
    const {name, value, attributes} = lines[i] as Tag
    if (name === 'EXTINF') {
      if (!Number.isInteger(value.duration) && params.compatibleVersion < 3) {
        params.compatibleVersion = 3
      }
      if (Math.round(value.duration) > params.targetDuration) {
        logger.fatal('EXTINF duration, when rounded to the nearest integer, MUST be less than or equal to the target duration')
      }
      segment.duration = value.duration
      segment.title = value.title
    }
    else if (name === 'EXT-X-BYTERANGE') {
      if (params.compatibleVersion < 4) {
        params.compatibleVersion = 4
      }
      segment.byterange = value
    }
    else if (name === 'EXT-X-DISCONTINUITY') {
      if (segment.parts.length > 0) {
        logger.fatal('EXT-X-DISCONTINUITY must appear before the first EXT-X-PART tag of the Parent Segment.')
      }
      segment.discontinuity = true
    }
    else if (name === 'EXT-X-KEY') {
      if (segment.parts.length > 0) {
        logger.fatal('EXT-X-KEY must appear before the first EXT-X-PART tag of the Parent Segment.')
      }

      if (attributes['METHOD'] !== 'NONE') {
        setCompatibleVersionOfKey(params, attributes)
        segment.key = new Key({
          method: attributes['METHOD'],
          uri: attributes['URI'],
          iv: attributes['IV'],
          format: attributes['KEYFORMAT'],
          formatVersion: attributes['KEYFORMATVERSIONS']
        })
      }
      else {
        segment.key = null
      }
    }
    else if (name === 'EXT-X-MAP') {
      if (segment.parts.length > 0) {
        logger.fatal('EXT-X-MAP must appear before the first EXT-X-PART tag of the Parent Segment.')
      }
      if (params.compatibleVersion < 5) {
        params.compatibleVersion = 5
      }
      params.hasMap = true
      segment.map = new MediaInitializationSection({
        uri: attributes['URI'],
        byterange: attributes['BYTERANGE'],
        key: segment.key
      })
    }
    else if (name === 'EXT-X-PROGRAM-DATE-TIME') {
      segment.programDateTime = value
    }
    else if (name === 'EXT-X-DATERANGE') {
      const attrs: Record<string, any> = {}
      for (const key of Object.keys(attributes)) {
        if (key.startsWith('SCTE35-') || key.startsWith('X-')) {
          attrs[key] = attributes[key]
        }
      }
      segment.dateRange = new DateRange({
        id: attributes['ID'],
        classId: attributes['CLASS'],
        start: attributes['START-DATE'],
        end: attributes['END-DATE'],
        duration: attributes['DURATION'],
        plannedDuration: attributes['PLANNED-DURATION'],
        endOnNext: attributes['END-ON-NEXT'],
        attributes: attrs
      })
    }
    else if (name === 'EXT-X-CUE-OUT') {
      segment.markers.push(new SpliceInfo({
        type: 'OUT',
        duration: (attributes && attributes.DURATION) || value
      }))
    }
    else if (name === 'EXT-X-CUE-IN') {
      segment.markers.push(new SpliceInfo({
        type: 'IN'
      }))
    }
    else if (
      name === 'EXT-X-CUE-OUT-CONT' ||
      name === 'EXT-X-CUE' ||
      name === 'EXT-OATCLS-SCTE35' ||
      name === 'EXT-X-ASSET' ||
      name === 'EXT-X-SCTE35'
    ) {
      segment.markers.push(new SpliceInfo({
        type: 'RAW',
        tagName: name,
        value
      }))
    }
    else if (name === 'EXT-X-PRELOAD-HINT' && !attributes['TYPE']) {
      logger.fatal('EXT-X-PRELOAD-HINT: TYPE attribute is mandatory')
    }
    else if (name === 'EXT-X-PRELOAD-HINT' && attributes['TYPE'] === 'PART' && partHint) {
      logger.fatal('Servers should not add more than one EXT-X-PRELOAD-HINT tag with the same TYPE attribute to a Playlist.')
    }
    else if ((name === 'EXT-X-PART' || name === 'EXT-X-PRELOAD-HINT') && !attributes['URI']) {
      logger.fatal('EXT-X-PART / EXT-X-PRELOAD-HINT: URI attribute is mandatory')
    }
    else if (name === 'EXT-X-PRELOAD-HINT' && attributes['TYPE'] === 'MAP') {
      if (mapHint) {
        logger.fatal('Servers should not add more than one EXT-X-PRELOAD-HINT tag with the same TYPE attribute to a Playlist.')
      }
      mapHint = true
      params.hasMap = true
      segment.map = new MediaInitializationSection({
        hint: true,
        uri: attributes['URI'],
        byterange: {length: attributes['BYTERANGE-LENGTH'], offset: attributes['BYTERANGE-START'] || 0}
      })
    }
    else if (name === 'EXT-X-PART' || (name === 'EXT-X-PRELOAD-HINT' && attributes['TYPE'] === 'PART')) {
      if (name === 'EXT-X-PART' && !attributes['DURATION']) {
        logger.fatal('EXT-X-PART: DURATION attribute is mandatory')
      }
      if (name === 'EXT-X-PRELOAD-HINT') {
        partHint = true
      }
      const partialSegment = new PartialSegment({
        hint: (name === 'EXT-X-PRELOAD-HINT'),
        uri: attributes['URI'],
        byterange: (name === 'EXT-X-PART' ? attributes['BYTERANGE'] : {length: attributes['BYTERANGE-LENGTH'], offset: attributes['BYTERANGE-START'] || 0}),
        duration: attributes['DURATION'],
        independent: attributes['INDEPENDENT'],
        gap: attributes['GAP']
      })
      segment.parts.push(partialSegment)
    }
  }
  return segment
}

function parsePrefetchSegment(
  lines: Line[],
  uri: any,
  start: number,
  end: number,
  mediaSequenceNumber: number,
  discontinuitySequence: number,
  params: Record<string, any>
) {
  const segment = new PrefetchSegment({uri, mediaSequenceNumber, discontinuitySequence})
  for (let i = start; i <= end; i++) {
    const {name, attributes} = lines[i] as Tag
    if (name === 'EXTINF') {
      logger.fatal('A prefetch segment must not be advertised with an EXTINF tag.')
    }
    else if (name === 'EXT-X-DISCONTINUITY') {
      logger.fatal('A prefetch segment must not be advertised with an EXT-X-DISCONTINUITY tag.')
    }
    else if (name === 'EXT-X-PREFETCH-DISCONTINUITY') {
      segment.discontinuity = true
    }
    else if (name === 'EXT-X-KEY') {
      if (attributes['METHOD'] !== 'NONE') {
        setCompatibleVersionOfKey(params, attributes)
        segment.key = new Key({
          method: attributes['METHOD'],
          uri: attributes['URI'],
          iv: attributes['IV'],
          format: attributes['KEYFORMAT'],
          formatVersion: attributes['KEYFORMATVERSIONS']
        })
      }
    }
    else if (name === 'EXT-X-MAP') {
      logger.fatal('Prefetch segments must not be advertised with an EXT-X-MAP tag.')
    }
  }
  return segment
}

function parseMediaPlaylist(lines: Line[], params: Record<string, any>) {
  const playlist = new MediaPlaylist()
  let segmentStart = -1
  let mediaSequence = 0
  let discontinuityFound = false
  let prefetchFound = false
  let discontinuitySequence = 0
  let currentKey: Key | null = null
  let currentMap: MediaInitializationSection | null = null
  let containsParts = false
  for (const [index, line] of lines.entries()) {
    const {name, value, attributes, category} = line as Tag
    if (category === 'Segment') {
      if (segmentStart === -1) {
        segmentStart = index
      }
      if (name === 'EXT-X-DISCONTINUITY') {
        discontinuityFound = true
      }
      continue
    }
    if (name === 'EXT-X-VERSION') {
      if (playlist.version === undefined) {
        playlist.version = value
      }
      else {
        logger.fatal('A Playlist file MUST NOT contain more than one EXT-X-VERSION tag.')
      }
    }
    else if (name === 'EXT-X-TARGETDURATION') {
      playlist.targetDuration = params.targetDuration = value
    }
    else if (name === 'EXT-X-MEDIA-SEQUENCE') {
      if (playlist.segments.length > 0) {
        logger.fatal('The EXT-X-MEDIA-SEQUENCE tag MUST appear before the first Media Segment in the Playlist.')
      }
      playlist.mediaSequenceBase = mediaSequence = value
    }
    else if (name === 'EXT-X-DISCONTINUITY-SEQUENCE') {
      if (playlist.segments.length > 0) {
        logger.fatal('The EXT-X-DISCONTINUITY-SEQUENCE tag MUST appear before the first Media Segment in the Playlist.')
      }
      if (discontinuityFound) {
        logger.fatal('The EXT-X-DISCONTINUITY-SEQUENCE tag MUST appear before any EXT-X-DISCONTINUITY tag.')
      }
      playlist.discontinuitySequenceBase = discontinuitySequence = value
    }
    else if (name === 'EXT-X-ENDLIST') {
      playlist.endlist = true
    }
    else if (name === 'EXT-X-PLAYLIST-TYPE') {
      playlist.playlistType = value
    }
    else if (name === 'EXT-X-I-FRAMES-ONLY') {
      if (params.compatibleVersion < 4) {
        params.compatibleVersion = 4
      }
      playlist.isIFrame = true
    }
    else if (name === 'EXT-X-INDEPENDENT-SEGMENTS') {
      if (playlist.independentSegments) {
        logger.fatal('EXT-X-INDEPENDENT-SEGMENTS tag MUST NOT appear more than once in a Playlist')
      }
      playlist.independentSegments = true
    }
    else if (name === 'EXT-X-START') {
      if (playlist.start) {
        logger.fatal('EXT-X-START tag MUST NOT appear more than once in a Playlist')
      }
      if (typeof attributes['TIME-OFFSET'] !== 'number') {
        logger.fatal('EXT-X-START: TIME-OFFSET attribute is REQUIRED')
      }
      playlist.start = {offset: attributes['TIME-OFFSET'], precise: attributes['PRECISE'] || false}
    }
    else if (name === 'EXT-X-SERVER-CONTROL') {
      if (!attributes['CAN-BLOCK-RELOAD']) {
        logger.fatal('EXT-X-SERVER-CONTROL: CAN-BLOCK-RELOAD=YES is mandatory for Low-Latency HLS')
      }
      playlist.lowLatencyCompatibility = {
        canBlockReload: attributes['CAN-BLOCK-RELOAD'],
        canSkipUntil: attributes['CAN-SKIP-UNTIL'],
        holdBack: attributes['HOLD-BACK'],
        partHoldBack: attributes['PART-HOLD-BACK']
      }
    }
    else if (name === 'EXT-X-PART-INF') {
      if (!attributes['PART-TARGET']) {
        logger.fatal('EXT-X-PART-INF: PART-TARGET attribute is mandatory')
      }
      playlist.partTargetDuration = attributes['PART-TARGET']
    }
    else if (name === 'EXT-X-RENDITION-REPORT') {
      if (!attributes['URI']) {
        logger.fatal('EXT-X-RENDITION-REPORT: URI attribute is mandatory')
      }
      if (attributes['URI'].search(/^[a-z]+:/) === 0) {
        logger.fatal('EXT-X-RENDITION-REPORT: URI must be relative to the playlist uri')
      }
      playlist.renditionReports.push(new RenditionReport({
        uri: attributes['URI'],
        lastMSN: attributes['LAST-MSN'],
        lastPart: attributes['LAST-PART']
      }))
    }
    else if (name === 'EXT-X-SKIP') {
      if (!attributes['SKIPPED-SEGMENTS']) {
        logger.fatal('EXT-X-SKIP: SKIPPED-SEGMENTS attribute is mandatory')
      }
      if (params.compatibleVersion < 9) {
        params.compatibleVersion = 9
      }
      playlist.skip = attributes['SKIPPED-SEGMENTS']
      mediaSequence += playlist.skip
    }
    else if (name === 'EXT-X-PREFETCH') {
      const segment = parsePrefetchSegment(
        lines,
        value,
        segmentStart === -1 ? index : segmentStart,
        index - 1,
        mediaSequence++,
        discontinuitySequence,
        params
      )
      if (segment) {
        if (segment.discontinuity) {
          segment.discontinuitySequence++
          discontinuitySequence = segment.discontinuitySequence
        }
        if (segment.key) {
          currentKey = segment.key
        }
        else if (segment.key === null) {
          currentKey = undefined
        }
        else {
          segment.key = currentKey
        }
        playlist.prefetchSegments.push(segment)
      }
      prefetchFound = true
      segmentStart = -1
    }
    else if (typeof line === 'string') {
      // uri
      if (segmentStart === -1) {
        logger.fatal('A URI line is not preceded by any segment tags')
      }
      if (!playlist.targetDuration) {
        logger.fatal('The EXT-X-TARGETDURATION tag is REQUIRED')
      }
      if (prefetchFound) {
        logger.fatal('These segments must appear after all complete segments.')
      }
      const segment = parseSegment(lines, line, segmentStart, index - 1, mediaSequence++, discontinuitySequence, params)
      if (segment) {
        if (segment.key === null) {
          currentKey = undefined
        }
        [discontinuitySequence, currentKey, currentMap] = addSegment(playlist, segment, discontinuitySequence, currentKey!, currentMap!)
        if (!containsParts && segment.parts.length > 0) {
          containsParts = true
        }
      }
      segmentStart = -1
    }
  }
  if (segmentStart !== -1) {
    const segment = parseSegment(lines, '', segmentStart, lines.length - 1, mediaSequence++, discontinuitySequence, params)
    if (segment) {
      if (segment.key === null) {
        currentKey = undefined
      }
      const {parts} = segment
      if (parts.length > 0 && !playlist.endlist && !parts[parts.length - 1]?.hint) {
        logger.fatal('If the Playlist contains EXT-X-PART tags and does not contain an EXT-X-ENDLIST tag, the Playlist must contain an EXT-X-PRELOAD-HINT tag with a TYPE=PART attribute')
      }
      addSegment(playlist, segment, discontinuitySequence, currentKey, currentMap)
      if (!containsParts && segment.parts.length > 0) {
        containsParts = true
      }
    }
  }
  checkDateRange(playlist.segments)
  if (playlist.lowLatencyCompatibility) {
    checkLowLatencyCompatibility(playlist, containsParts)
  }
  playlist.duration = playlist.segments.reduce((total, segment) => {
    return typeof segment.duration === 'number' ? total + segment.duration : total
  }, 0)
  return playlist
}

function addSegment(
  playlist: MediaPlaylist,
  segment: Segment,
  discontinuitySequence: number,
  currentKey?: Key,
  currentMap?: MediaInitializationSection
): [number, Key, MediaInitializationSection] {
  const {discontinuity, key, map, byterange, uri} = segment
  if (discontinuity) {
    segment.discontinuitySequence = discontinuitySequence + 1
  }
  if (!key) {
    segment.key = currentKey
  }
  if (!map) {
    segment.map = currentMap!
  }
  if (byterange && byterange.offset === -1) {
    const {segments} = playlist
    if (segments.length > 0) {
      const prevSegment = segments[segments.length - 1]!
      if (prevSegment.byterange && prevSegment.uri === uri) {
        byterange.offset = prevSegment.byterange.offset + prevSegment.byterange.length
      }
      else {
        logger.fatal('If offset of EXT-X-BYTERANGE is not present, a previous Media Segment MUST be a sub-range of the same media resource')
      }
    }
    else {
      logger.fatal('If offset of EXT-X-BYTERANGE is not present, a previous Media Segment MUST appear in the Playlist file')
    }
  }
  playlist.segments.push(segment)
  return [segment.discontinuitySequence, segment.key!, segment.map]
}

function checkDateRange(segments: Segment[]) {
  const earliestDates = new Map()
  const rangeList = new Map()
  let hasDateRange = false
  let hasProgramDateTime = false
  for (let i = segments.length - 1; i >= 0; i--) {
    const {programDateTime, dateRange} = segments[i]
    if (programDateTime) {
      hasProgramDateTime = true
    }
    if (dateRange && dateRange.start) {
      hasDateRange = true
      if (dateRange.endOnNext && (dateRange.end || dateRange.duration)) {
        logger.fatal('An EXT-X-DATERANGE tag with an END-ON-NEXT=YES attribute MUST NOT contain DURATION or END-DATE attributes.')
      }
      const start = dateRange.start.getTime()
      const duration = dateRange.duration || 0
      if (dateRange.end && dateRange.duration) {
        if ((start + duration * 1000) !== dateRange.end.getTime()) {
          logger.fatal('END-DATE MUST be equal to the value of the START-DATE attribute plus the value of the DURATION')
        }
      }
      if (dateRange.endOnNext) {
        dateRange.end = earliestDates.get(dateRange.classId)
      }
      earliestDates.set(dateRange.classId, dateRange.start)
      const end = dateRange.end ? dateRange.end.getTime() : dateRange.start.getTime() + (dateRange.duration || 0) * 1000
      const range = rangeList.get(dateRange.classId)
      if (range) {
        for (const entry of range) {
          if ((entry.start <= start && entry.end > start) || (entry.start >= start && entry.start < end)) {
            logger.fatal('DATERANGE tags with the same CLASS should not overlap')
          }
        }
        range.push({start, end})
      }
      else if (dateRange.classId) {
        rangeList.set(dateRange.classId, [{start, end}])
      }
    }
  }
  if (hasDateRange && !hasProgramDateTime) {
    logger.fatal('If a Playlist contains an EXT-X-DATERANGE tag, it MUST also contain at least one EXT-X-PROGRAM-DATE-TIME tag.')
  }
}

function checkLowLatencyCompatibility({lowLatencyCompatibility, targetDuration, partTargetDuration, segments, renditionReports}: any, containsParts) {
  const {canSkipUntil, holdBack, partHoldBack} = lowLatencyCompatibility
  if (canSkipUntil < targetDuration * 6) {
    logger.fatal('The Skip Boundary must be at least six times the EXT-X-TARGETDURATION.')
  }
  // Its value is a floating-point number of seconds and .
  if (holdBack < targetDuration * 3) {
    logger.fatal('HOLD-BACK must be at least three times the EXT-X-TARGETDURATION.')
  }
  if (containsParts) {
    if (partTargetDuration === undefined) {
      logger.fatal('EXT-X-PART-INF is required if a Playlist contains one or more EXT-X-PART tags')
    }
    if (partHoldBack === undefined) {
      logger.fatal('EXT-X-PART: PART-HOLD-BACK attribute is mandatory')
    }
    if (partHoldBack < partTargetDuration) {
      logger.fatal('PART-HOLD-BACK must be at least PART-TARGET')
    }
    for (const [segmentIndex, {parts}] of segments.entries()) {
      // if (parts.length > 0 && segmentIndex < segments.length - 3) {
      //   logger.fatal('Remove EXT-X-PART tags from the Playlist after they are greater than three target durations from the end of the Playlist.')
      // }
      for (const [partIndex, {duration}] of parts.entries()) {
        if (duration === undefined) {
          continue
        }
        if (duration > partTargetDuration) {
          logger.fatal('PART-TARGET is the maximum duration of any Partial Segment')
        }
        if (partIndex < parts.length - 1 && duration < partTargetDuration * 0.85) {
          logger.fatal('All Partial Segments except the last part of a segment must have a duration of at least 85% of PART-TARGET')
        }
      }
    }
  }
  for (const report of renditionReports) {
    const lastSegment = segments[segments.length - 1]
    if (report.lastMSN === null || report.lastMSN === undefined) {
      report.lastMSN = lastSegment.mediaSequenceNumber
    }
    if ((report.lastPart === null || report.lastPart === undefined) && lastSegment.parts.length > 0) {
      report.lastPart = lastSegment.parts.length - 1
    }
  }
}

function CHECKTAGCATEGORY(category: TagCategory, params: Record<string, any>) {
  if (category === 'Segment' || category === 'MediaPlaylist') {
    if (params.isMasterPlaylist === undefined) {
      params.isMasterPlaylist = false
      return
    }
    if (params.isMasterPlaylist) {
      logger.fatal('The file contains both media and master playlist tags.')
    }
    return
  }
  if (category === 'MasterPlaylist') {
    if (params.isMasterPlaylist === undefined) {
      params.isMasterPlaylist = true
      return
    }
    if (params.isMasterPlaylist === false) {
      logger.fatal('The file contains both media and master playlist tags.')
    }
  }
}

type Tag = {
  name: string
  category: TagCategory
  value: any
  attributes: any
}

function parseTag(line: string, params: Record<string, any>): Tag | null {
  const [name, param] = splitTag(line)
  const category = getTagCategory(name)
  CHECKTAGCATEGORY(category, params)
  if (category === 'Unknown') {
    return null
  }
  if (category === 'MediaPlaylist' && name !== 'EXT-X-RENDITION-REPORT' && name !== 'EXT-X-PREFETCH') {
    if (params.hash[name]) {
      logger.fatal('There MUST NOT be more than one Media Playlist tag of each type in any Media Playlist')
    }
    params.hash[name] = true
  }
  const [value, attributes] = parseTagParam(name, param)
  return {name, category, value, attributes}
}

type Line = string | Tag

function lexicalParse(text: string, params: Record<string, any>) {
  const lines: Line[] = []
  for (const l of text.split('\n')) {
    const line = l.trim()
    if (!line) {
      continue
    }
    if (line.startsWith('#')) {
      if (line.startsWith('#EXT')) {
        // tag
        const tag = parseTag(line, params)
        if (tag) {
          lines.push(tag)
        }
      }
      // comment
      continue
    }
    // uri
    lines.push(line)
  }
  if (lines.length === 0 || (lines[0] as Tag).name !== 'EXTM3U') {
    logger.fatal('The EXTM3U tag MUST be the first line.')
  }
  return lines
}

function semanticParse(lines: Line[], params: Record<string, any>) {
  let playlist: MasterPlaylist | MediaPlaylist
  if (params.isMasterPlaylist) {
    playlist = parseMasterPlaylist(lines, params)
  }
  else {
    playlist = parseMediaPlaylist(lines, params)
    if (!playlist.isIFrame && params.hasMap && params.compatibleVersion < 6) {
      params.compatibleVersion = 6
    }
  }
  if (params.compatibleVersion > 1) {
    if (!playlist.version || playlist.version < params.compatibleVersion) {
      logger.fatal(`EXT-X-VERSION needs to be ${params.compatibleVersion} or higher.`)
    }
  }
  return playlist
}

export default function parse(text: string): MasterPlaylist | MediaPlaylist {
  const params: Record<string, any> = {
    version: undefined,
    isMasterPlaylist: undefined,
    hasMap: false,
    targetDuration: 0,
    compatibleVersion: 1,
    isClosedCaptionsNone: false,
    hash: {}
  }

  const lines = lexicalParse(text, params)
  const playlist = semanticParse(lines, params)
  playlist.source = text

  return playlist
}
