/*
 * libmedia getKeySystemFromSystemId
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

import { DRMType } from './drm'

export default function getKeySystemFromSystemId(systemId: Uint8Array): DRMType {
  const map = {
    'edef8ba979d64acea3c827dcd51d21ed': DRMType.WIDEVINE,
    '9a04f07998404286ab92e65be0885f95': DRMType.PLAYREADY,
    'e2719d58a985b3c9781ab030af78d30e': DRMType.CLEARKEY,
    '94ce86fb07ff4f43adb893d2fa968ca2': DRMType.FAIRPLAY
  }
  let key = ''
  systemId.forEach((v) => {
    let s = v.toString(16)
    if (s.length === 1) {
      s = '0' + s
    }
    key += s
  })
  return map[key]
}
