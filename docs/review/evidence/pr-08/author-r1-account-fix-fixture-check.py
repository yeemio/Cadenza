from pathlib import Path
import hashlib,json,re,subprocess,sys

base=Path(sys.argv[1]);work=Path(sys.argv[2])
test='tests/pr08/intent-api.pg.spec.ts'
before=(base/test).read_text();after=(work/test).read_text()
sha=lambda value:hashlib.sha256(value if isinstance(value,bytes) else value.encode()).hexdigest()
edits=[
 ('Factory stores the actual NORMAL location code',
  'location: string; rackLocation: string;',
  'location: string; locationCode: string; rackLocation: string;'),
 ('receive-goods fixture references that actual location code',
  "locationId:f.location,locationCode:'P08-LINE',",
  "locationId:f.location,locationCode:f.locationCode,"),
 ('report_output fixture parameterizes the same location code; later parameters remain aligned',
  "VALUES($1,$2,$3,1,20,20,$4,'M',$5,'P08-LINE',$6,$7,$8) RETURNING id`,[f.enterpriseId,f.plantId,reportId,uom,f.location,f.userId,f.login,unitId])",
  "VALUES($1,$2,$3,1,20,20,$4,'M',$5,$6,$7,$8,$9) RETURNING id`,[f.enterpriseId,f.plantId,reportId,uom,f.location,f.locationCode,f.userId,f.login,unitId])"),
 ('department lookup binds the existing real seed department to the same plant and enterprise',
  "    const plantId=await one('SELECT id FROM org_node WHERE code=$1',[`PLNT-${code}`]), deptId=await one('SELECT id FROM org_node WHERE code=$1',[`DEPT-${code}-JZ`])",
  """    const plantId=await one('SELECT id FROM org_node WHERE code=$1',[`PLNT-${code}`])
    const deptId=await one("SELECT id FROM org_node WHERE code=$1 AND kind='department' AND parent_kind='plant' AND parent_id=$2 AND enterprise_id=$3",[`DEPT-${code}-JZ`,plantId,enterpriseId])"""),
 ('warehouse required fields and legal distinct numeric warehouse/NORMAL codes',
  """    const line=await one(`INSERT INTO warehouse(enterprise_id,plant_id,code,name,warehouse_type) VALUES($1,$2,$3,$3,'LINE_SIDE') RETURNING id`,[enterpriseId,plantId,`P08-LINE-${i}`])
    const warehouse=await one(`INSERT INTO warehouse(enterprise_id,plant_id,code,name,warehouse_type) VALUES($1,$2,$3,$3,'WAREHOUSE') RETURNING id`,[enterpriseId,plantId,`P08-FG-${i}`])
    const location=await one(`INSERT INTO storage_location(enterprise_id,plant_id,warehouse_id,location_kind,code) VALUES($1,$2,$3,'NORMAL','P08-LINE') RETURNING id`,[enterpriseId,plantId,line])""",
  """    const lineCode=String(8100+i*2), warehouseCode=String(8101+i*2), locationCode=`${lineCode}0001`
    const line=await one(`INSERT INTO warehouse(enterprise_id,plant_id,dept_id,code,name,warehouse_type,material_types) VALUES($1,$2,$3,$4,$5,'LINE_SIDE',ARRAY[2,3]) RETURNING id`,[enterpriseId,plantId,deptId,lineCode,`P08-LINE-${i}`])
    const warehouse=await one(`INSERT INTO warehouse(enterprise_id,plant_id,dept_id,code,name,warehouse_type,material_types) VALUES($1,$2,$3,$4,$5,'WAREHOUSE',ARRAY[3]) RETURNING id`,[enterpriseId,plantId,deptId,warehouseCode,`P08-FG-${i}`])
    const location=await one(`INSERT INTO storage_location(enterprise_id,plant_id,warehouse_id,location_kind,code) VALUES($1,$2,$3,'NORMAL',$4) RETURNING id`,[enterpriseId,plantId,line,locationCode])"""),
 ('store the generated location code in each Factory',
  'materialId,wc,defs,location,rackLocation,warehouse,offset:8+i})',
  'materialId,wc,defs,location,locationCode,rackLocation,warehouse,offset:8+i})'),
 ('report HTTP request changes only its fixture location-code reference',
  "targetLocationId:f.location,targetLocationCode:'P08-LINE',",
  "targetLocationId:f.location,targetLocationCode:f.locationCode,"),
 ('controller-authorized synthetic account expression; all f.login references and Auth roles/permissions stay intact',
  'const login=`pr08-${code.toLowerCase()}`',
  'const login=`pr08${code.toLowerCase()}`'),
]
expected=before;operations=[]
for description,old,new in edits:
 assert expected.count(old)==1,description
 expected=expected.replace(old,new,1)
 operations.append({'description':description,'old':old,'new':new})
assert expected==after,'An unlisted byte change exists'
describe="describe('PR08 actual API + actual isolated PG; no skips or business doubles',()=>{"
beforeBody=before[before.index(describe):];afterBody=after[after.index(describe):]
oldRef="targetLocationId:f.location,targetLocationCode:'P08-LINE',"
newRef="targetLocationId:f.location,targetLocationCode:f.locationCode,"
assert beforeBody.count(oldRef)==1 and afterBody.count(newRef)==1
assert beforeBody.replace(oldRef,newRef,1)==afterBody
assert [s for s in before.splitlines() if 'expect(' in s]==[s for s in after.splitlines() if 'expect(' in s]
assert [s for s in before.splitlines() if re.search(r'\bit\(',s)]==[s for s in after.splitlines() if re.search(r'\bit\(',s)]
assert 'for(const index of [0,1]) {' in beforeBody
assert beforeBody.count('    it(')==2 and beforeBody.count('\n  it(')==3
assert not re.search(r'\b(?:it|describe)\.(?:skip|todo|only)\s*\(',after)
afterAll=before[before.index('afterAll(async()=>{'):before.index(describe)]
assert afterAll==after[after.index('afterAll(async()=>{'):after.index(describe)]
assert before[before.index('const storage = '):before.index('beforeAll(async () => {')]==after[after.index('const storage = '):after.index('beforeAll(async () => {')]
schemaPath='packages/persistence/src/migrations/0003-master-data.ts'
schema=(work/schemaPath).read_text()
seedPath='packages/persistence/src/seed.ts';seed=(work/seedPath).read_text()
orgPath='packages/persistence/src/migrations/0002-org-auth.ts';org=(work/orgPath).read_text()
warehouse=schema[schema.index('CREATE TABLE warehouse ('):schema.index('-- ============ 货架')]
assert 'dept_id uuid NOT NULL REFERENCES org_node (id)' in warehouse
assert "code text NOT NULL CHECK (code ~ '^[0-9]{4}$')" in warehouse
assert 'material_types integer[] NOT NULL CHECK (cardinality(material_types) >= 1)' in warehouse
assert "code text NOT NULL CHECK (code ~ '^[0-9]{6}$' OR code ~ '^[0-9]{8}$')" in schema
for code in ['SZ','HF']:
 assert f"{{ kind: 'department', code: 'DEPT-{code}-JZ'," in seed
 assert re.search(rf"kind: 'department', code: 'DEPT-{code}-JZ',[^\n]*parentCode: 'PLNT-{code}'",seed)
 assert re.search(rf"kind: 'plant', code: 'PLNT-{code}',[^\n]*parentCode: 'LE-HDMIKE'",seed)
assert "kind: 'legal_entity', code: 'LE-HDMIKE'," in seed and "parentCode: 'ENT-HD'" in seed
assert "VALUES($1,$2,$2,2,'M',1,'PR08')" in after
assert "VALUES ($1,$2,$2,3,'M',1,'PR08')" in after
codeLine=next(line.strip() for line in after.splitlines() if 'const lineCode=' in line)
nodeCode="const assert=require('node:assert/strict');const f=new Function('i',"+json.dumps(codeLine+";return {lineCode,warehouseCode,locationCode}")+");const rows=[0,1].map(f);for(const x of rows){assert.match(x.lineCode,/^[0-9]{4}$/);assert.match(x.warehouseCode,/^[0-9]{4}$/);assert.match(x.locationCode,/^[0-9]{8}$/);assert.equal(x.locationCode.slice(0,4),x.lineCode)}assert.equal(new Set(rows.flatMap(x=>[x.lineCode,x.warehouseCode])).size,4);assert.equal(new Set(rows.map(x=>x.locationCode)).size,2);console.log(JSON.stringify(rows));"
evaluated=subprocess.run(['node','-e',nodeCode],capture_output=True,text=True)
assert evaluated.returncode==0,evaluated.stderr
codes=json.loads(evaluated.stdout)
assert after.count("'P08-LINE'")==0
assert "location_kind,code) VALUES($1,$2,$3,'RACK','010101')" in after
loginLine=next(line for line in after.splitlines() if 'const login=' in line)
assert 'const login=`pr08-${code.toLowerCase()}`' in before
assert 'const login=`pr08${code.toLowerCase()}`' in loginLine
assert "CONSTRAINT user_account_login_charset_ck CHECK (login_name ~ '^[A-Za-z0-9]+$')" in org
loginNode="const assert=require('node:assert/strict');const f=new Function('code',"+json.dumps(loginLine.strip()+";return login")+");const values=['SZ','HF'].map(f);assert.equal(new Set(values).size,2);for(const value of values)assert.match(value,/^[A-Za-z0-9]+$/);console.log(JSON.stringify(values));"
loginProcess=subprocess.run(['node','-e',loginNode],capture_output=True,text=True)
assert loginProcess.returncode==0,loginProcess.stderr
logins=json.loads(loginProcess.stdout)
assert logins==['pr08sz','pr08hf']
assert all(("loginName: '"+name+"'") not in seed for name in logins)
assert all(re.fullmatch(r'[A-Za-z0-9]+',s) is not None for s in logins)
alterLoginFiles=[]
for p in (work/'packages/persistence/src/migrations').glob('*.ts'):
 if p.name=='0002-org-auth.ts':continue
 text=p.read_text()
 if re.search(r'ALTER\s+TABLE\s+(?:public\.)?user_account|user_account_login_charset_ck',text,re.I):alterLoginFiles.append(p.name)
assert not alterLoginFiles
changedExisting=[];unchangedFiles=0
for p in base.rglob('*'):
 if not p.is_file():continue
 relative=p.relative_to(base)
 if (work/relative).read_bytes()!=p.read_bytes():changedExisting.append(relative.as_posix())
 else:unchangedFiles+=1
assert changedExisting==[test]
receipt=json.loads((base/'docs/review/evidence/pr-08/controller-r0.json').read_text())
source=[]
for item in receipt['sourceFiles']:
 p=item['path'];oldSha=sha((base/p).read_bytes());assert oldSha==item['sha256']
 current=sha((work/p).read_bytes())
 source.append({'path':p,'sha256':current,'parentSha256':oldSha,'unchanged':oldSha==current})
assert sum(x['unchanged'] for x in source)==24 and len(source)==25
fingerprint=sha(''.join(x['path']+'\t'+x['sha256']+'\n' for x in sorted(source,key=lambda x:x['path'])))
proof={
 'status':'PASS_AUTHORIZED_FIXTURE_DELTA_PRESERVATION',
 'scope':'Static code/bytes/schema evidence only; no business runner or PostgreSQL invoked.',
 'exactParentHead':'63eb1d7d508ff3028be725e1bbcf7b1294881665',
 'test':test,'parentTestSha256':sha(before),'candidateTestSha256':sha(after),
 'exactTextEdits':operations,'registeredScenariosPreservedStatic':7,
 'scenarioNamesAndRegistrationLinesUnchanged':True,'allAssertionLinesByteIdentical':True,
 'describeEntirelyByteIdentical':False,'describeBytesBefore':len(beforeBody.encode()),'describeBytesAfter':len(afterBody.encode()),
 'onlyDescribeChange':'One source occurrence: report POST targetLocationCode literal P08-LINE -> f.locationCode, shared by the two factory cases. All other describe bytes identical.',
 'describeNormalizedSha256':sha(beforeBody.replace(oldRef,newRef,1)),
 'afterAllUnchanged':True,'storageClientResponseLossAndRejectedUnchangedHelpersByteIdentical':True,
 'actualCodeExpressionEvaluation':{'command':['node','-e',nodeCode],'exitCode':evaluated.returncode,'rows':codes},
 'warehouseMaterialTypes':{'LINE_SIDE':[2,3],'WAREHOUSE':[3]},
 'schemaAndSeedFiles':[{'path':p,'sha256':sha((work/p).read_bytes()),'unchangedFromParent':(work/p).read_bytes()==(base/p).read_bytes()} for p in [schemaPath,seedPath,orgPath]],
 'materializedParentFilesUnchanged':unchangedFiles,'changedExistingPaths':changedExisting,
 'sourceTestFingerprint':fingerprint,'sourceTestFiles':source,
 'resolvedAdditionalFixtureBlock':{
  'status':'STATIC_REPAIRED_WITH_EXPLICIT_CONTROLLER_SCOPE_DECISION_NOT_RUNTIME_EXECUTED',
  'scopeDecision':'PR08-R1-SCOPE-DECISION-ACCOUNT-FIXTURE',
  'testPath':test,'line':after.splitlines().index(loginLine)+1,'candidateSourceLine':loginLine,
  'originalValues':['pr08-sz','pr08-hf'],'candidateValues':logins,
  'constraintPath':orgPath,'constraint':'user_account_login_charset_ck',
  'pattern':'^[A-Za-z0-9]+$','eachNewValueAcceptedStatically':True,'distinctFromSeedAccountNames':True,
  'laterMigrationAltersConstraint':False,'modifiedByThisIncrement':True,
  'actualExpressionEvaluation':{'command':['node','-e',loginNode],'exitCode':loginProcess.returncode,'stdout':loginProcess.stdout},
  'identityBoundary':'Only the synthetic login expression changed. Independent original user creation, same role/permissions/plant/department/password hashing and real Nest/Auth login remain byte-identical. All uses of the existing f.login reference remain, except the separately authorized location-code references.',
  'noRuntimeClaim':True
 }
}
print(json.dumps(proof,ensure_ascii=False,indent=2))
