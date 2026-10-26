// == ARGUS AGENT PROJECT ==
/** The filesystem a path is on: the deepest mount that holds it. */
import { describe, expect, it } from 'vitest'
import { filesystemOf } from '../../src/service.js'

const MOUNTINFO = [
  '22 1 259:2 / / rw,relatime shared:1 - ext4 /dev/nvme0n1p2 rw',
  '45 22 0:40 / /home/romeo rw,nosuid shared:30 - ecryptfs /home/romeo/.Private rw,ecryptfs_sig=x',
  '46 22 0:41 / /data rw,relatime - ecryptfs /home/romeo/.Private rw',
  '47 46 0:42 / /data/projects/fast rw - tmpfs tmpfs rw',
  '48 22 0:43 / /srv/my\\040data rw - xfs /dev/sdb1 rw',
].join('\n')

describe('filesystemOf', () => {
  it('names the filesystem of the deepest mount holding the path', () => {
    expect(filesystemOf('/data/projects', MOUNTINFO)).toBe('ecryptfs')
    expect(filesystemOf('/data/projects/fast/x', MOUNTINFO)).toBe('tmpfs')
    expect(filesystemOf('/srv/argus-agent/data/projects', MOUNTINFO)).toBe('ext4')
    expect(filesystemOf('/home/romeo/.cache/argus/data/projects', MOUNTINFO)).toBe('ecryptfs')
    expect(filesystemOf('/srv/my data/projects', MOUNTINFO)).toBe('xfs')
    // A sibling whose name starts the same is not inside it.
    expect(filesystemOf('/database', MOUNTINFO)).toBe('ext4')
  })
})
