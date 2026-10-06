/**
 * 迁移领域逻辑运行时验证（Node + fake-indexeddb）
 * 覆盖：预检拦截、revision 乐观锁冲突整包不写入、三处原子写入、写入失败回滚、
 * 时效归属（历史实测/调节单认原站、当前排行走新站）、旧备份（无迁移记录/无快照）兼容。
 */
import 'fake-indexeddb/auto'
import assert from 'node:assert/strict'
import { db, seedDatabase, exportSnapshot, importSnapshot, SEED_STAMP } from '@/utils/db'
import {
  activateDueMigrations,
  commitMigration,
  previewMigration,
  resolveBuildingStationAt,
  resolveMeasureStationId,
  resolveAdjustStationId,
  resolveValveStationAt,
  MigrationConflictError
} from '@/utils/migration'

let passed = 0
function ok(name: string): void {
  passed += 1
  console.log(`  ✓ ${name}`)
}

const DAY = 86400000
// 用播种基准时钟（约 2024-11-20）推演，保证种子里的预约迁移 mg-2（+7 日）确属「待生效」
const now = SEED_STAMP + 1000

async function main(): Promise<void> {
  await db.open()
  await seedDatabase()

  // 播种数据：bd-1 已在 st-1→st-2 迁移（-10 日生效）；bd-3 有已调节未复核单 aj-2
  const bd1 = await db.buildings.get('bd-1')
  const bd3 = await db.buildings.get('bd-3')
  const vv1 = await db.valves.get('vv-1')
  assert.equal(bd1!.stationId, 'st-2', '播种后 bd-1 当前挂 st-2')
  assert.equal(vv1!.stationId, 'st-2')
  ok('播种：已生效迁移的楼栋/阀门当前归属已在目标站')

  const migrations = (await db.stationMigrations.toArray()).map((m) => ({
    buildingIds: m.buildingIds,
    sourceStationId: m.sourceStationId,
    targetStationId: m.targetStationId,
    effectiveAt: m.effectiveAt
  }))

  // ---------- 时效归属：历史不追溯 ----------
  const histMeasure = await db.measures.get('ms-1-1') // -16 日，快照 st-1
  const newMeasure = await db.measures.get('ms-1-2') // -2 日，快照 st-2
  assert.equal(resolveMeasureStationId(histMeasure!, vv1, migrations), 'st-1')
  assert.equal(resolveMeasureStationId(newMeasure!, vv1, migrations), 'st-2')
  ok('时效归属：生效前实测认来源站，生效后实测认目标站')

  const aj1 = await db.adjusts.get('aj-1') // -14 日派单，快照 st-1
  assert.equal(resolveAdjustStationId(aj1!, vv1, migrations), 'st-1')
  ok('时效归属：生效前的历史调节单仍认原站（虽楼栋已改挂 st-2）')

  assert.equal(resolveValveStationAt(vv1!, bd1, now, migrations), 'st-2')
  assert.equal(resolveBuildingStationAt('bd-1', now, migrations), 'st-2')
  ok('时效归属：当前排行/录数/派单口径走新站 st-2')

  // 待生效迁移 mg-2（bd-3 → st-2，+7 日）：当前时点早于最早迁移，认来源站 st-1
  assert.equal(resolveBuildingStationAt('bd-3', now, migrations), 'st-1')
  assert.equal(resolveValveStationAt((await db.valves.get('vv-5'))!, bd3, now, migrations), 'st-1')
  const future = now + 8 * DAY
  assert.equal(resolveBuildingStationAt('bd-3', future, migrations), 'st-2')
  ok('时效归属：待生效迁移当前不计入，越过生效时点后才算目标站')

  // ---------- 预检：未完调节单拦截 ----------
  const preview = await previewMigration({
    sourceStationId: 'st-1',
    targetStationId: 'st-2',
    effectiveAt: now + DAY,
    buildingIds: ['bd-3']
  })
  assert.equal(preview.buildings.length, 1)
  assert.equal(preview.valves.length, 2)
  assert.equal(preview.blockers.length, 1)
  assert.equal(preview.blockers[0].valveCode, 'BL-7-01')
  assert.equal(preview.blockers[0].state, '已调节')
  ok('预检：列出受影响阀门，并检出已调节未复核单拦截迁移')

  // 无未完单的楼栋（bd-4 / A座，vv-7/vv-8 均无调节单）预检通过
  const previewOk = await previewMigration({
    sourceStationId: 'st-2',
    targetStationId: 'st-1',
    effectiveAt: now + DAY,
    buildingIds: ['bd-4']
  })
  assert.equal(previewOk.blockers.length, 0)
  ok('预检：调节单均已闭环的楼栋可迁移')

  // ---------- 提交：未完单在事务内再挡一次 ----------
  await assert.rejects(
    commitMigration({
      sourceStationId: 'st-1',
      targetStationId: 'st-2',
      buildingIds: ['bd-3'],
      effectiveAt: now + DAY,
      operator: '测试',
      remark: '',
      expectedBuildingRevisions: { 'bd-3': bd3!.revision ?? 0 },
      expectedValveRevisions: Object.fromEntries(preview.valves.map((v) => [v.id, v.revision ?? 0]))
    }, now),
    (err: unknown) => err instanceof MigrationConflictError && err.blockers.length === 1
  )
  const bd3After = await db.buildings.get('bd-3')
  assert.equal(bd3After!.stationId, 'st-1', '被拦截后楼栋归属不变')
  assert.equal((await db.stationMigrations.toArray()).length, 2, '不新增迁移记录')
  ok('提交：未完单触发整包中止，楼栋归属/阀门/迁移记录均未改动')

  // ---------- 提交：revision 冲突，整包不写入 ----------
  // 模拟「别人在确认前改过」：把 bd-2 的 revision 抬高，但提交仍用预检时旧 revision
  const bd2 = await db.buildings.get('bd-2')
  await db.buildings.put({ ...bd2!, name: '5号楼（他人已改）', revision: (bd2!.revision ?? 0) + 1, updatedAt: now })
  const vv3 = await db.valves.get('vv-3')
  const vv4 = await db.valves.get('vv-4')
  const conflict = await commitMigration({
    sourceStationId: 'st-1',
    targetStationId: 'st-2',
    buildingIds: ['bd-2'],
    effectiveAt: now + DAY,
    operator: '测试',
    remark: '',
    expectedBuildingRevisions: { 'bd-2': bd2!.revision ?? 0 },
    expectedValveRevisions: { 'vv-3': vv3!.revision ?? 0, 'vv-4': vv4!.revision ?? 0 }
  }, now).then(
    () => null,
    (err: unknown) => err
  )
  assert.ok(conflict instanceof MigrationConflictError)
  assert.equal(conflict.conflicts.some((c) => c.kind === '楼栋' && c.id === 'bd-2'), true)
  const bd2After = await db.buildings.get('bd-2')
  assert.equal(bd2After!.stationId, 'st-1', '冲突时楼栋归属保持原值')
  assert.equal(bd2After!.name, '5号楼（他人已改）', '冲突时他人修改原样保留')
  const vv3After = await db.valves.get('vv-3')
  assert.equal(vv3After!.stationId, 'st-1', '冲突时阀门冗余站未被换掉一半')
  assert.equal((await db.stationMigrations.toArray()).length, 2, '冲突时不写迁移记录')
  ok('乐观锁：楼栋在确认前被改过 → 整包不写入并保留原数据（含他人修改）')

  // ---------- 正常提交（立即生效）：三处一起写入 + 版本号递增 ----------
  // 走 bd-4（st-2 → st-1，无未完单）验证干净的立即迁移路径
  const bd4 = await db.buildings.get('bd-4')
  const bd4Rev = bd4!.revision ?? 0
  const valvesBd4 = await db.valves.where('buildingId').equals('bd-4').toArray()
  const immediateAt = now - 1000 // 生效时点已到
  const record = await commitMigration({
    sourceStationId: 'st-2',
    targetStationId: 'st-1',
    buildingIds: ['bd-4'],
    effectiveAt: immediateAt,
    operator: '测试员',
    remark: '正常批次',
    expectedBuildingRevisions: { 'bd-4': bd4Rev },
    expectedValveRevisions: Object.fromEntries(valvesBd4.map((v) => [v.id, v.revision ?? 0]))
  }, now)
  assert.equal(record.buildingIds.join(','), 'bd-4')
  assert.deepEqual(record.valveIds.sort(), ['vv-7', 'vv-8'])
  assert.equal(record.valveCodes.join(','), 'BL-A-01,BL-A-02')
  assert.ok(record.activatedAt, '立即生效批次带激活时间')
  const bd4Migrated = await db.buildings.get('bd-4')
  assert.equal(bd4Migrated!.stationId, 'st-1')
  assert.equal(bd4Migrated!.revision, bd4Rev + 1)
  for (const id of ['vv-7', 'vv-8']) {
    const v = await db.valves.get(id)
    assert.equal(v!.stationId, 'st-1')
  }
  assert.equal((await db.stationMigrations.toArray()).length, 3)
  ok('正常提交：楼栋归属 + 阀门冗余站 + 迁移记录三处一致写入，revision 递增')

  // 迁移到点后时效解析切到新站
  const chain3 = (await db.stationMigrations.toArray()).map((m) => ({
    buildingIds: m.buildingIds,
    sourceStationId: m.sourceStationId,
    targetStationId: m.targetStationId,
    effectiveAt: m.effectiveAt
  }))
  assert.equal(resolveBuildingStationAt('bd-4', now, chain3), 'st-1')

  // ---------- 预约未来生效：只写迁移记录，台账不提前翻牌；到点激活补齐 ----------
  // 用刚迁到 st-1 的干净楼栋 bd-4 预约 3 天后切回 st-2
  const bd4Current = await db.buildings.get('bd-4')
  const valvesBd4Now = await db.valves.where('buildingId').equals('bd-4').toArray()
  const scheduledAt = now + 3 * DAY
  const scheduled = await commitMigration({
    sourceStationId: 'st-1',
    targetStationId: 'st-2',
    buildingIds: ['bd-4'],
    effectiveAt: scheduledAt,
    operator: '预约',
    remark: '计划三天后切回',
    expectedBuildingRevisions: { 'bd-4': bd4Current!.revision ?? 0 },
    expectedValveRevisions: Object.fromEntries(valvesBd4Now.map((v) => [v.id, v.revision ?? 0]))
  }, now)
  assert.equal(scheduled.activatedAt, undefined, '预约批次未激活')
  const bd4Pending = await db.buildings.get('bd-4')
  assert.equal(bd4Pending!.stationId, 'st-1', '待生效期间楼栋台账仍挂来源站，不提前翻牌')
  for (const id of ['vv-7', 'vv-8']) {
    assert.equal((await db.valves.get(id))!.stationId, 'st-1', '待生效期间阀门冗余站仍认来源站')
  }
  const chainPending = (await db.stationMigrations.toArray()).map((m) => ({
    buildingIds: m.buildingIds,
    sourceStationId: m.sourceStationId,
    targetStationId: m.targetStationId,
    effectiveAt: m.effectiveAt
  }))
  assert.equal(resolveBuildingStationAt('bd-4', now + DAY, chainPending), 'st-1', '未到预约点时保持立即批次归属 st-1')
  assert.equal(resolveBuildingStationAt('bd-4', now + 4 * DAY, chainPending), 'st-2', '越过生效点解析到目标站')
  ok('预约未来生效：只写迁移记录，待生效期间排行/录数/派单仍走来源站')

  // 到点激活：幂等补齐两处物理写入
  const beforeActivate = await db.stationMigrations.where('effectiveAt').equals(scheduledAt).first()
  const activation = await activateDueMigrations(now + 4 * DAY)
  assert.ok(activation.activated.some((m) => m.id === beforeActivate!.id), '预约批次被激活')
  assert.equal((await db.buildings.get('bd-4'))!.stationId, 'st-2', '激活后楼栋归属翻牌')
  for (const id of ['vv-7', 'vv-8']) {
    assert.equal((await db.valves.get(id))!.stationId, 'st-2', '激活后阀门冗余站翻牌')
  }
  const afterRecord = await db.stationMigrations.get(beforeActivate!.id)
  assert.ok(afterRecord!.activatedAt !== undefined, '激活时间已回写迁移记录')
  // 幂等：再跑一遍不重复激活
  const second = await activateDueMigrations(now + 5 * DAY)
  assert.equal(second.activated.length, 0)
  ok('到点激活：楼栋归属与阀门冗余站补齐写入，重复执行幂等')

  // 到点时仍有未完单 → 跳过翻牌并保留待激活
  // （bd-3 的 mg-2 预约 +7 日，vv-5 有已调节单 aj-2；把时钟拨到 +8 日激活应跳过）
  const blockedActivation = await activateDueMigrations(now + 8 * DAY)
  assert.ok(blockedActivation.skipped.some((s) => s.migration.id === 'mg-2'), 'mg-2 因未完单暂缓激活')
  assert.equal((await db.buildings.get('bd-3'))!.stationId, 'st-1', '暂缓激活的楼栋保持来源站')
  // 闭环后再次激活成功
  const aj2 = await db.adjusts.get('aj-2')
  await db.adjusts.put({ ...aj2!, state: '已复核', reviewNote: '闭环' })
  const retry = await activateDueMigrations(now + 8 * DAY)
  assert.ok(retry.activated.some((m) => m.id === 'mg-2'))
  assert.equal((await db.buildings.get('bd-3'))!.stationId, 'st-2')
  ok('到点激活遇未完单暂缓不翻牌，闭环后重试成功，不存在半迁移')

  // ---------- 旧备份兼容：v2 备份无 stationMigrations、实测/调节单无 stationId ----------
  const legacy = await exportSnapshot()
  // 构造一份"旧备份"：删迁移记录、抹掉所有归属快照
  const legacyPayload = {
    ...legacy,
    dbVersion: 2,
    stationMigrations: undefined,
    measures: legacy.measures.map(({ stationId: _s, ...rest }) => rest),
    adjusts: legacy.adjusts.map(({ stationId: _s, ...rest }) => rest)
  }
  await importSnapshot(legacyPayload as never)
  assert.equal(await db.stationMigrations.count(), 0)
  const oldMs = await db.measures.get('ms-1-1')
  const oldValve = await db.valves.get('vv-1')
  // 无迁移记录可解析 → 回退阀门当前冗余站（st-2），不报错
  const resolved = resolveMeasureStationId(oldMs!, oldValve, [])
  assert.equal(resolved, 'st-2')
  ok('旧备份兼容：缺迁移记录与归属快照时安全回退当前冗余站，不抛错')

  // 导入带迁移记录的备份后，缺快照的历史数据按时效解析兜底认原站。
  // 前面用例对多栋楼造过后续迁移，这里只保留 mg-1（bd-1 在 -10 日 st-1→st-2）以得到确定性结论。
  const withChain = {
    ...legacyPayload,
    stationMigrations: legacy.stationMigrations!.filter((m) => m.id === 'mg-1')
  }
  await importSnapshot(withChain as never)
  const ms11 = await db.measures.get('ms-1-1')
  const valve1 = await db.valves.get('vv-1')
  const chainImported = (await db.stationMigrations.toArray()).map((m) => ({
    buildingIds: m.buildingIds,
    sourceStationId: m.sourceStationId,
    targetStationId: m.targetStationId,
    effectiveAt: m.effectiveAt
  }))
  assert.equal(chainImported.length, 1)
  assert.equal(resolveMeasureStationId(ms11!, valve1, chainImported), 'st-1', '旧实测按日期时效解析回原站')
  const ajImported = await db.adjusts.get('aj-1')
  assert.equal(resolveAdjustStationId(ajImported!, valve1, chainImported), 'st-1', '旧调节单按创建时间解析回原站')
  // 迁移后录入的新实测（ms-1-2，-2 日）解析到新站
  const ms12 = await db.measures.get('ms-1-2')
  assert.equal(resolveMeasureStationId(ms12!, valve1, chainImported), 'st-2', '迁移后旧实测(缺快照)按日期解析到新站')
  ok('旧备份 + 迁移记录：无快照的历史实测/调节单按时效解析兜底认原站，不追溯改站')

  await db.close()
  console.log(`\n全部 ${passed} 项运行时验证通过`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
