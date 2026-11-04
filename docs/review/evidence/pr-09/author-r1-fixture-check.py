"""PR09 R1 static preservation proof; no business runner or database is invoked."""
from pathlib import Path
import argparse
import hashlib
import json
import re
import subprocess

parser = argparse.ArgumentParser()
parser.add_argument("--parent", type=Path, required=True)
parser.add_argument("--candidate", type=Path, required=True)
args = parser.parse_args()
base, work = args.parent.resolve(), args.candidate.resolve()
path = "tests/pr09/kitting.pg.spec.ts"
sha = lambda data: hashlib.sha256(data).hexdigest()
before, after = (base / path).read_bytes(), (work / path).read_bytes()
assert sha(before) == "11645af5ca7de0c0db4baa98183a9310aca8915d22c3fccd8a45a20151c8976c"
old, new = before.decode(), after.decode()
edits = [
    {
        "name": "legal foreign warehouse and derived NORMAL location constants",
        "before": "const bases:Record<string,{outputQuantity:string;outputUom:string}>={}\n",
        "after": "const bases:Record<string,{outputQuantity:string;outputUom:string}>={}\nconst WH_B_CODE='9309',LOC_B_CODE=`${WH_B_CODE}0001`\n",
    },
    {
        "name": "stock helper references the actual foreign NORMAL location code",
        "before": "locationCode:options.foreign?'P09-B':LOC_LINE_SEMI_CODE",
        "after": "locationCode:options.foreign?LOC_B_CODE:LOC_LINE_SEMI_CODE",
    },
    {
        "name": "same-factory seed department and required warehouse columns",
        "before": "  const whB=await one(`INSERT INTO warehouse(enterprise_id,plant_id,code,name,warehouse_type) VALUES($1,$2,'P09-B','P09-B','WAREHOUSE') RETURNING id`,[fx.enterpriseId,plantB])\n",
        "after": "  const deptB=await one(\"SELECT id FROM org_node WHERE code='DEPT-HF-JZ' AND kind='department' AND parent_kind='plant' AND parent_id=$1 AND enterprise_id=$2\",[plantB,fx.enterpriseId])\n  const whB=await one(`INSERT INTO warehouse(enterprise_id,plant_id,dept_id,code,name,warehouse_type,material_types) VALUES($1,$2,$3,$4,'P09-B','WAREHOUSE',ARRAY[1]) RETURNING id`,[fx.enterpriseId,plantB,deptB,WH_B_CODE])\n",
    },
    {
        "name": "NORMAL location INSERT uses the same derived code",
        "before": "  locB=await one(`INSERT INTO storage_location(enterprise_id,plant_id,warehouse_id,location_kind,code) VALUES($1,$2,$3,'NORMAL','P09-B') RETURNING id`,[fx.enterpriseId,plantB,whB])\n",
        "after": "  locB=await one(`INSERT INTO storage_location(enterprise_id,plant_id,warehouse_id,location_kind,code) VALUES($1,$2,$3,'NORMAL',$4) RETURNING id`,[fx.enterpriseId,plantB,whB,LOC_B_CODE])\n",
    },
]
expected = old
for edit in edits:
    assert expected.count(edit["before"]) == 1, edit["name"]
    expected = expected.replace(edit["before"], edit["after"], 1)
assert expected.encode() == after, "Changes exceed the four named fixture substitutions"
marker = "describe('PR09 actual PG group calculation, measurement and isolation',()=>{"
old_body, new_body = old[old.index(marker):], new[new.index(marker):]
assert old_body == new_body
assert old[old.index("afterAll("):] == new[new.index("afterAll("):]
assert [line for line in old.splitlines() if "expect(" in line] == [
    line for line in new.splitlines() if "expect(" in line
]
plain = len(re.findall(r"^  it\(", new_body, re.M))
each = len(re.findall(r"^  it\.each\(", new_body, re.M))
assert plain == 13 and each == 1
assert "it.each([{noBom:true},{empty:true},{basis:false}])" in new_body
assert ".skip(" not in new_body and ".todo(" not in new_body

declaration = next(line for line in new.splitlines() if line.startswith("const WH_B_CODE="))
code = declaration + "\nconsole.log(JSON.stringify({warehouseCode:WH_B_CODE,locationCode:LOC_B_CODE}))"
process = subprocess.run(["node", "--input-type=module", "-e", code], capture_output=True, text=True)
assert process.returncode == 0, process.stderr
codes = json.loads(process.stdout)
assert re.fullmatch(r"[0-9]{4}", codes["warehouseCode"])
assert re.fullmatch(r"[0-9]{8}", codes["locationCode"])
assert codes["locationCode"] == codes["warehouseCode"] + "0001"
seed_path = "packages/persistence/src/seed.ts"
schema_path = "packages/persistence/src/migrations/0003-master-data.ts"
seed, schema = (work / seed_path).read_text(), (work / schema_path).read_text()
for fragment in [
    "code: 'DEPT-HF-JZ', name: '合肥厂-绞制车间部', parentCode: 'PLNT-HF'",
    "code: 'PLNT-HF', name: '合肥线缆厂', parentCode: 'LE-HDMIKE'",
    "code: 'LE-HDMIKE', name: '华东电缆制造有限公司', parentCode: 'ENT-HD'",
]:
    assert fragment in seed
for fragment in [
    "dept_id uuid NOT NULL REFERENCES org_node (id)",
    "code text NOT NULL CHECK (code ~ '^[0-9]{4}$')",
    "material_types integer[] NOT NULL CHECK (cardinality(material_types) >= 1)",
    "code text NOT NULL CHECK (code ~ '^[0-9]{6}$' OR code ~ '^[0-9]{8}$')",
]:
    assert fragment in schema
assert "VALUES($1,$2,$2,1,'M',1,'PR09')" in new
assert new.count("ARRAY[1]") == 1
assert "locationId:options.foreign?locB:LOC_LINE_SEMI,locationCode:options.foreign?LOC_B_CODE:LOC_LINE_SEMI_CODE" in new

parent_receipt = json.loads((base / "docs/review/evidence/pr-09/author-r0.json").read_text())
files = []
for item in sorted(parent_receipt["sourceAndTestCandidate"]["files"], key=lambda x: x["path"]):
    rel = item["path"]
    pre, post = (base / rel).read_bytes(), (work / rel).read_bytes()
    assert sha(pre) == item["sha256"]
    assert rel == path or pre == post
    files.append({"path": rel, "sha256": sha(post), "unchangedFromParent": pre == post})
assert len(files) == 8 and sum(item["unchangedFromParent"] for item in files) == 7
fingerprint = sha("".join(item["path"] + "\t" + item["sha256"] + "\n" for item in files).encode())
protected = []
for rel in [
    "packages/application/src/inventory-posting.ts",
    "tests/pr02/object-write-scope.pg.spec.ts",
    "tests/pr03/quality-availability.pg.spec.ts",
    seed_path, schema_path,
]:
    data = (base / rel).read_bytes()
    assert data == (work / rel).read_bytes()
    protected.append({"path": rel, "sha256": sha(data)})
unchanged = 0
for source in base.rglob("*"):
    if source.is_file() and source.relative_to(base).as_posix() != path:
        assert source.read_bytes() == (work / source.relative_to(base)).read_bytes(), str(source)
        unchanged += 1
print(json.dumps({
    "status": "PASS_STATIC_PRESERVATION_ONLY",
    "exactParentHead": "9d261c274291e4aa17c31200e84572f81acf2e63",
    "preimageSha256": sha(before),
    "candidateTestSha256": sha(after),
    "candidateTestBytes": len(after),
    "exactTextEdits": edits,
    "allOtherTestBytesUnchanged": True,
    "fullDescribeBytes": len(new_body.encode()),
    "fullDescribeSha256": sha(new_body.encode()),
    "fullDescribeAndAfterAllByteIdentical": True,
    "allAssertionLinesByteIdentical": True,
    "registrations": {"plainIt": plain, "itEachGroups": each, "itEachRows": 3, "total": plain + 3},
    "fixtureExpression": {"command": process.args, "exitCode": process.returncode, "stdout": process.stdout, "stderr": process.stderr, "values": codes},
    "seedDepartment": {"code": "DEPT-HF-JZ", "plantCode": "PLNT-HF", "enterpriseCode": "ENT-HD", "lookupChecksPlantAndEnterprise": True},
    "warehouseMaterialTypes": [1],
    "stockMaterialType": 1,
    "sourceTestFingerprint": fingerprint,
    "sourceTestFiles": files,
    "protectedInputs": protected,
    "unchangedMaterializedParentFiles": unchanged,
    "businessRunnerInvoked": False,
    "postgresqlInvoked": False,
    "notATypecheckOrBusinessPass": True,
}, ensure_ascii=False, indent=2))
