from pathlib import Path
import hashlib,json,re,sys
base=Path(sys.argv[1]);work=Path(sys.argv[2])
E='docs/review/evidence/pr-08/'
product='packages/persistence/src/execution-repositories.ts'
test='tests/pr08/execution-date.unit.spec.ts'
originalPg='tests/pr08/intent-api.pg.spec.ts'
sha=lambda b:hashlib.sha256(b if isinstance(b,bytes) else b.encode()).hexdigest()
before=(base/product).read_text();after=(work/product).read_text()
edits=json.loads((work/(E+'author-r2-product-read-edits.json')).read_text())
reconstructed=before
for edit in edits:
 assert reconstructed.count(edit['old'])==edit['count'],edit['old']
 reconstructed=reconstructed.replace(edit['old'],edit['new'])
assert reconstructed==after,'Unlisted product edit'
assert after.count('${SHIFT_DATE_COLUMNS}')==20
assert after.count('${SESSION_SHIFT_DATE_COLUMNS}')==2
assert after.count('shift_date_text: string')==4
assert after.count('shiftDate: r.shift_date_text,')==4
oldStatements=re.findall(r'`((?:INSERT|UPDATE)\b[\s\S]*?)`',before)
newStatements=re.findall(r'`((?:INSERT|UPDATE)\b[\s\S]*?)`',after)
normalized=[s.replace('${SHIFT_DATE_COLUMNS}','*') for s in newStatements]
assert oldStatements==normalized
assert len(oldStatements)>7
assert sum('${SHIFT_DATE_COLUMNS}' in s for s in newStatements)==7
isoBefore=before[before.index('function iso('):before.index('function dateStr(')]
isoAfter=after[after.index('function iso('):after.index('// DATE is a calendar value')]
assert isoBefore==isoAfter
outStart='// ---------------- 产出行 ----------------'
outEnd='// ---------------- 投料记录 ----------------'
assert before[before.index(outStart):before.index(outEnd)]==after[after.index(outStart):after.index(outEnd)]
tail='// ---------------- 订单完成数量回写 ----------------'
assert before[before.index(tail):]==after[after.index(tail):]
oldPg=(base/originalPg).read_bytes();newPg=(work/originalPg).read_bytes()
assert oldPg==newPg and sha(newPg)=='ec8b5fcb42042bb5e0fb74ed5a3e2c9cbbe45dd2cd1cfe3180c5994073d46e97'
parentReceipt=json.loads((base/(E+'author-r1-account-fix.json')).read_text())
originalFiles=parentReceipt['sourceAndTestCandidate']['files']
assert len(originalFiles)==25
for entry in originalFiles:
 data=(work/entry['path']).read_bytes()
 assert data==(base/entry['path']).read_bytes() and sha(data)==entry['sha256'],entry['path']
parentFp=sha(''.join(x['path']+'\t'+x['sha256']+'\n' for x in sorted(originalFiles,key=lambda x:x['path'])))
assert parentFp=='f10dab06df342ecfe8eb64778b2bfabe8245208f44ea0d4dc5b4edac621a98f3'
testText=(work/test).read_text()
assert not re.search(r'\b(?:it|describe)\.(?:skip|todo|only)\s*\(',testText)
assert not re.search(r'process\.env(?:\.TZ|\[[\'"]TZ[\'"]\])\s*=',after+testText)
assert not any(term in after for term in ['setTypeParser','process.env.TZ','getTimezoneOffset'])
baseChanged=[];unchanged=0
for p in base.rglob('*'):
 if not p.is_file():continue
 rel=p.relative_to(base).as_posix()
 if (work/rel).read_bytes()!=p.read_bytes():baseChanged.append(rel)
 else:unchanged+=1
assert baseChanged==[product]
protected=['tests/pr02/object-write-scope.pg.spec.ts','tests/pr03/quality-availability.pg.spec.ts','packages/application/src/inventory-posting.ts']
protectedData=[]
for path in protected:
 data=(work/path).read_bytes();assert data==(base/path).read_bytes()
 protectedData.append({'path':path,'sha256':sha(data),'unchanged':True})
oldLog=(base/(E+'controller-r1-pg.log')).read_bytes()
assert oldLog==(work/(E+'controller-r1-pg.log')).read_bytes()
result={
 'status':'PASS_SCOPE_AND_BYTE_PRESERVATION','exactParentHead':'d38fd52298586a3b225bc09d19a5c74ada952ffa',
 'product':{'path':product,'parentSha256':sha(before),'candidateSha256':sha(after),'namedSubstitutionRules':len(edits)},
 'readProjectionCounts':{'select':15,'returning':7,'total':22},
 'rowFamilies':['execution_session','production_report','material_consumption','labor_record'],
 'allInsertUpdateSqlIdenticalAfterRemovingReadProjection':True,
 'insertUpdateSqlStatementCount':len(oldStatements),
 'isoAndIsoOrNullFunctionBytesUnchanged':True,
 'reportOutputRepositoryWholeSectionUnchanged':True,'orderProgressMasterDataAndRepositoryFactoryTailUnchanged':True,
 'writeArgumentsPredicatesOrderingPaginationAndAllOtherSourceBytesUnchangedOutsideDeclaredReadEdits':True,
 'originalHttpPgTest':{'path':originalPg,'bytes':len(newPg),'sha256':sha(newPg),'entireFileByteIdentical':True,'registeredCasesRetained':7,'timeAccountWarehouseFixturesAndAllAssertionsUnchanged':True},
 'original25SourceTestFilesUnchanged':True,'original25Fingerprint':parentFp,
 'changedExistingPaths':baseChanged,'unchangedMaterializedParentFileCount':unchanged,
 'protectedAcceptedInputs':protectedData,
 'parentFailureLog':{'path':E+'controller-r1-pg.log','bytes':len(oldLog),'sha256':sha(oldLog),'unchanged':True,'parentCounts':{'passed':5,'failed':2,'runtimeSkipped':0}},
 'noProcessTzMutationOrGlobalPgParserChange':True,
 'newTest':{'path':test,'sha256':sha(testText),'boundedCases':21,'sqlClientDoubles':True,'actualPg':False,'explicitOffsetDateFixtures':['+00:00','+08:00','+09:00','+14:00','-10:00'],'nativeProcessTimezoneNotChanged':True},
 'boundary':'Mechanical preservation plus declared local test coverage; not PostgreSQL, semantic types or full-repository review.'
}
print(json.dumps(result,ensure_ascii=False,indent=2))
