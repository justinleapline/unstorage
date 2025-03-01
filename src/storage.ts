import destr from 'destr'
import type { Storage, Driver, WatchCallback, StorageValue } from './types'
import memory from './drivers/memory'
import { normalizeKey, normalizeBase, asyncCall, stringify } from './_utils'

interface StorageCTX {
  mounts: Record<string, Driver>
  mountpoints: string[]
  watching: boolean
  watchListeners: Function[]
}

export interface CreateStorageOptions {
  driver?: Driver
}

export function createStorage (opts: CreateStorageOptions = {}): Storage {
  const ctx: StorageCTX = {
    mounts: { '': opts.driver || memory() },
    mountpoints: [''],
    watching: false,
    watchListeners: []
  }

  const getMount = (key: string) => {
    for (const base of ctx.mountpoints) {
      if (key.startsWith(base)) {
        return {
          relativeKey: key.substr(base.length),
          driver: ctx.mounts[base]
        }
      }
    }
    return {
      relativeKey: key,
      driver: ctx.mounts['']
    }
  }

  const getMounts = (base: string) => {
    return ctx.mountpoints
      .filter(mountpoint => mountpoint.startsWith(base) || base!.startsWith(mountpoint))
      .map(mountpoint => ({
        relativeBase: base.length > mountpoint.length ? base!.substr(mountpoint.length) : undefined,
        mountpoint,
        driver: ctx.mounts[mountpoint]
      }))
  }

  const onChange: WatchCallback = (event, key) => {
    if (!ctx.watching) { return }
    key = normalizeKey(key)
    for (const listener of ctx.watchListeners) {
      listener(event, key)
    }
  }

  const startWatch = async () => {
    if (ctx.watching) { return }
    ctx.watching = true
    for (const mountpoint in ctx.mounts) {
      await watch(ctx.mounts[mountpoint], onChange, mountpoint)
    }
  }

  const storage: Storage = {
    // Item
    hasItem (key) {
      key = normalizeKey(key)
      const { relativeKey, driver } = getMount(key)
      return asyncCall(driver.hasItem, relativeKey)
    },
    getItem (key) {
      key = normalizeKey(key)
      const { relativeKey, driver } = getMount(key)
      return asyncCall(driver.getItem, relativeKey).then(val => destr(val))
    },
    async setItem (key, value) {
      if (value === undefined) {
        return storage.removeItem(key)
      }
      key = normalizeKey(key)
      const { relativeKey, driver } = getMount(key)
      if (!driver.setItem) {
        return // Readonly
      }
      await asyncCall(driver.setItem, relativeKey, stringify(value))
      if (!driver.watch) {
        onChange('update', key)
      }
    },
    async removeItem (key, removeMeta = true) {
      key = normalizeKey(key)
      const { relativeKey, driver } = getMount(key)
      if (!driver.removeItem) {
        return // Readonly
      }
      await asyncCall(driver.removeItem, relativeKey)
      if (removeMeta) {
        await asyncCall(driver.removeItem, relativeKey + '$')
      }
      if (!driver.watch) {
        onChange('remove', key)
      }
    },
    // Meta
    async getMeta (key, nativeMetaOnly) {
      key = normalizeKey(key)
      const { relativeKey, driver } = getMount(key)
      const meta = Object.create(null)
      if (driver.getMeta) {
        Object.assign(meta, await asyncCall(driver.getMeta, relativeKey))
      }
      if (!nativeMetaOnly) {
        const val = await asyncCall(driver.getItem, relativeKey + '$').then(val => destr(val))
        if (val && typeof val === 'object') {
          // TODO: Support date by destr?
          if (typeof val.atime === 'string') { val.atime = new Date(val.atime) }
          if (typeof val.mtime === 'string') { val.mtime = new Date(val.mtime) }
          Object.assign(meta, val)
        }
      }
      return meta
    },
    setMeta (key: string, value: any) {
      return this.setItem(key + '$', value)
    },
    removeMeta (key: string) {
      return this.removeItem(key + '$')
    },
    // Keys
    async getKeys (base) {
      base = normalizeBase(base)
      const keyGroups = await Promise.all(getMounts(base).map(async (mount) => {
        const rawKeys = await asyncCall(mount.driver.getKeys, mount.relativeBase)
        return rawKeys.map(key => mount.mountpoint + normalizeKey(key))
      }))
      const keys = keyGroups.flat()
      return base
        ? keys.filter(key => key.startsWith(base!) && !key.endsWith('$'))
        : keys.filter(key => !key.endsWith('$'))
    },
    // Utils
    async clear (base) {
      base = normalizeBase(base)
      await Promise.all(getMounts(base).map(async (m) => {
        if (m.driver.clear) {
          return asyncCall(m.driver.clear)
        }
        // Fallback to remove all keys if clear not implemented
        if (m.driver.removeItem) {
          const keys = await m.driver.getKeys()
          return Promise.all(keys.map(key => m.driver.removeItem!(key)))
        }
        // Readonly
      }))
    },
    async dispose () {
      await Promise.all(Object.values(ctx.mounts).map(driver => dispose(driver)))
    },
    async watch (callback) {
      await startWatch()
      ctx.watchListeners.push(callback)
    },
    // Mount
    mount (base, driver) {
      base = normalizeBase(base)
      if (base && ctx.mounts[base]) {
        throw new Error(`already mounted at ${base}`)
      }
      if (base) {
        ctx.mountpoints.push(base)
        ctx.mountpoints.sort((a, b) => b.length - a.length)
      }
      ctx.mounts[base] = driver
      if (ctx.watching) {
        Promise.resolve(watch(driver, onChange, base))
          .catch(console.error) // eslint-disable-line no-console
      }
      return storage
    },
    async unmount (base: string, _dispose = true) {
      base = normalizeBase(base)
      if (!base /* root */ || !ctx.mounts[base]) {
        return
      }
      if (_dispose) {
        await dispose(ctx.mounts[base])
      }
      ctx.mountpoints = ctx.mountpoints.filter(key => key !== base)
      delete ctx.mounts[base]
    }
  }

  return storage
}

export type Snapshot<T=string> = Record<string, T>

export async function snapshot (storage: Storage, base: string): Promise<Snapshot<string>> {
  base = normalizeBase(base)
  const keys = await storage.getKeys(base)
  const snapshot: any = {}
  await Promise.all(keys.map(async (key) => {
    snapshot[key.substr(base.length)] = await storage.getItem(key)
  }))
  return snapshot
}

export async function restoreSnapshot (driver: Storage, snapshot: Snapshot<StorageValue>, base: string = '') {
  base = normalizeBase(base)
  await Promise.all(Object.entries(snapshot).map(e => driver.setItem(base + e[0], e[1])))
}

function watch (driver: Driver, onChange: WatchCallback, base: string) {
  if (driver.watch) {
    return driver.watch((event, key) => onChange(event, base + key))
  }
}

async function dispose (driver: Driver) {
  if (typeof driver.dispose === 'function') {
    await asyncCall(driver.dispose)
  }
}
