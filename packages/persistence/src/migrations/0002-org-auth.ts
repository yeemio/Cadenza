import type { Migration } from './index'

/**
 * 0002 组织与权限迁移（P1-S2-IDENTITY）。
 *
 * 依据冻结合同 architecture/contracts/frozen/p1/org-auth.md：
 * - OA-S1 org_node：code 全局唯一（active 口径 partial unique，OA-01/06 逻辑删除状态列）、
 *   parent 无环（path/depth 物化 + 应用层校验 + kind/parent 复合外键与自引用禁断，OA-02/34）；
 * - OA-S2 user_account：login_name 全局唯一 + 字符集 CHECK（OA-10）；不可删除自身由命令层守卫（OA-11）；
 * - OA-S3 role：enterprise 范围内 (name)/(alias)/(sort) 三个 partial unique（active 行，OA-17）；
 * - OA-S4 scope_grant：(principal_type, principal_id, scope_type, scope_object_id) 唯一（OA-22），
 *   permissions 为行内集合（同一主体对同一对象的同类授权至多一行）；
 * - OA-S5 audit_entry：0001 已建；高影响操作 reason 必填由命令层域规则强制（OA-29）；
 * - OA-S6 external_mapping：五元组唯一索引（OA-32）。
 * - OA-31 全表审计四列 created_at/created_by/updated_at/updated_by；
 * - OA-33 业务表 plant_id 非空隔离列（user_account / shift_calendar）。
 */
export const migration0002: Migration = {
  version: '0002',
  name: 'org-auth',
  up: /* sql */ `
    -- ============ 组织树（OA-S1；OA-01/02/03/04/06/08/34） ============
    -- 单表 org_node 承载四层：enterprise/legal_entity/plant/department/work_center（OA-08）。
    -- path/depth 物化：根 '/<id>/'，子级追加 '<id>/'；祖先判定 = path 前缀（OA-34）。
    -- 无环机制：应用层域规则（OA-02）+ (id,kind) 复合外键锁层级配对 + 自引用 CHECK。
    CREATE TABLE org_node (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      kind text NOT NULL CHECK (kind IN ('enterprise','legal_entity','plant','department','work_center')),
      code text NOT NULL CHECK (code <> ''),
      name text NOT NULL CHECK (name <> ''),
      parent_id uuid,
      parent_kind text,
      path text NOT NULL CHECK (path LIKE '/%' AND path LIKE '%/'),
      depth integer NOT NULL CHECK (depth >= 0),
      plant_code text,
      company_org_code text,
      dept_category smallint,
      status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','retired')),
      enterprise_id uuid NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text,
      updated_at timestamptz NOT NULL DEFAULT now(),
      updated_by text,
      CONSTRAINT org_node_id_kind_key UNIQUE (id, kind),
      CONSTRAINT org_node_parent_fkey FOREIGN KEY (parent_id, parent_kind)
        REFERENCES org_node (id, kind) ON DELETE RESTRICT,
      CONSTRAINT org_node_enterprise_fkey FOREIGN KEY (enterprise_id)
        REFERENCES org_node (id) ON DELETE RESTRICT,
      CONSTRAINT org_node_kind_parent_ck CHECK (
        (kind = 'enterprise' AND parent_id IS NULL AND parent_kind IS NULL AND depth = 0)
        OR (kind = 'legal_entity' AND parent_kind = 'enterprise')
        OR (kind = 'plant' AND parent_kind = 'legal_entity')
        OR (kind = 'department' AND parent_kind IN ('plant','department'))
        OR (kind = 'work_center' AND parent_kind = 'department')
      ),
      -- OA-02 第一道：不可选自身为上级（下级/环由应用层域规则 + path 物化机制拒绝）
      CONSTRAINT org_node_no_self_parent_ck CHECK (parent_id IS NULL OR parent_id <> id),
      -- OA-03 机构类型字典仅 3 值（department 节点必填且限定 1/2/3）
      CONSTRAINT org_node_dept_category_ck CHECK (
        kind <> 'department' OR dept_category IN (1,2,3)
      ),
      -- OA-04 工厂编码：plant 节点必填、最长 10 字符；公司组织编码选填
      CONSTRAINT org_node_plant_code_ck CHECK (
        kind <> 'plant' OR (plant_code IS NOT NULL AND length(plant_code) BETWEEN 1 AND 10)
      )
    );
    -- OA-01 机构编码/名称全局唯一（active 口径；retired 行保留历史占用，MD-36 同型）
    CREATE UNIQUE INDEX org_node_code_active_uidx ON org_node (code) WHERE status = 'active';
    CREATE UNIQUE INDEX org_node_name_active_uidx ON org_node (name) WHERE status = 'active';
    CREATE INDEX org_node_parent_idx ON org_node (parent_id);
    CREATE INDEX org_node_path_idx ON org_node (path text_pattern_ops);
    CREATE INDEX org_node_enterprise_kind_idx ON org_node (enterprise_id, kind) WHERE status = 'active';

    -- ============ 角色（OA-S3；OA-17/18/19） ============
    CREATE TABLE role (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      enterprise_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      name text NOT NULL CHECK (name <> ''),
      alias text NOT NULL CHECK (alias <> ''),
      sort integer NOT NULL,
      is_system smallint NOT NULL DEFAULT 1 CHECK (is_system IN (1,2)),
      parent_role_id uuid REFERENCES role (id) ON DELETE RESTRICT,
      status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','retired')),
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text,
      updated_at timestamptz NOT NULL DEFAULT now(),
      updated_by text
    );
    -- OA-17 名称/别名/排序三者任一重复即拒（enterprise 为租户树根，覆盖"租户及其上级范围"）
    CREATE UNIQUE INDEX role_name_active_uidx ON role (enterprise_id, name) WHERE status = 'active';
    CREATE UNIQUE INDEX role_alias_active_uidx ON role (enterprise_id, alias) WHERE status = 'active';
    CREATE UNIQUE INDEX role_sort_active_uidx ON role (enterprise_id, sort) WHERE status = 'active';
    CREATE INDEX role_enterprise_idx ON role (enterprise_id);

    -- ============ 用户账号（OA-S2；OA-10～OA-16、OA-33） ============
    -- WorkItem 措辞 person(user+password_hash)：按冻结合同 OA-S2 表名落 user_account（同一实体）。
    CREATE TABLE user_account (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      enterprise_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      login_name text NOT NULL,
      password_hash text NOT NULL,
      display_name text NOT NULL CHECK (display_name <> ''),
      dept_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      workshop_dept_id uuid REFERENCES org_node (id) ON DELETE RESTRICT,
      role_id uuid NOT NULL REFERENCES role (id) ON DELETE RESTRICT,
      login_platform text NOT NULL CHECK (login_platform IN ('WEB','PDA')),
      account_status text NOT NULL DEFAULT 'enabled' CHECK (account_status IN ('enabled','disabled')),
      phone text,
      plant_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      failed_login_count integer NOT NULL DEFAULT 0,
      locked_until timestamptz,
      status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','retired')),
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text,
      updated_at timestamptz NOT NULL DEFAULT now(),
      updated_by text,
      -- OA-10 登录账号全局唯一、字符集仅字母与数字
      CONSTRAINT user_account_login_name_unique UNIQUE (login_name),
      CONSTRAINT user_account_login_charset_ck CHECK (login_name ~ '^[A-Za-z0-9]+$')
    );
    CREATE INDEX user_account_enterprise_idx ON user_account (enterprise_id, status);
    CREATE INDEX user_account_dept_idx ON user_account (dept_id);
    -- OA-33 业务表 plant_id 非空隔离列（服务端查询过滤口径）
    CREATE INDEX user_account_plant_idx ON user_account (plant_id);

    -- ============ 授权行（OA-S4；OA-21/22/23） ============
    -- 授权事实以落库显式行为准（OA-21）；同一主体对同一对象的同类授权至多一行（OA-22），
    -- 岗位许可集合收敛在该行 permissions。
    CREATE TABLE scope_grant (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      enterprise_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      principal_type text NOT NULL CHECK (principal_type IN ('role','user')),
      principal_id uuid NOT NULL,
      permissions text[] NOT NULL CHECK (cardinality(permissions) >= 1),
      scope_type text NOT NULL CHECK (scope_type IN ('enterprise','plant','workshop')),
      scope_object_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','retired')),
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text,
      updated_at timestamptz NOT NULL DEFAULT now(),
      updated_by text,
      CONSTRAINT scope_grant_key_unique UNIQUE (principal_type, principal_id, scope_type, scope_object_id)
    );
    CREATE INDEX scope_grant_principal_idx ON scope_grant (principal_type, principal_id) WHERE status = 'active';
    CREATE INDEX scope_grant_enterprise_idx ON scope_grant (enterprise_id);

    -- ============ 会话（登录签发/撤销） ============
    CREATE TABLE auth_session (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      token_hash text NOT NULL UNIQUE,
      user_id uuid NOT NULL REFERENCES user_account (id) ON DELETE RESTRICT,
      enterprise_id uuid NOT NULL REFERENCES org_node (id),
      plant_id uuid,
      login_platform text NOT NULL,
      issued_at timestamptz NOT NULL,
      expires_at timestamptz NOT NULL,
      revoked_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text,
      updated_at timestamptz NOT NULL DEFAULT now(),
      updated_by text
    );
    CREATE INDEX auth_session_user_idx ON auth_session (user_id, expires_at);

    -- ============ 班次日历（WorkItem 列示；无冻结 OA 规则，最小表结构占位） ============
    CREATE TABLE shift_calendar (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      plant_id uuid NOT NULL REFERENCES org_node (id) ON DELETE RESTRICT,
      code text NOT NULL,
      name text NOT NULL CHECK (name <> ''),
      start_time time NOT NULL,
      end_time time NOT NULL,
      status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','retired')),
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text,
      updated_at timestamptz NOT NULL DEFAULT now(),
      updated_by text,
      CONSTRAINT shift_calendar_plant_code_unique UNIQUE (plant_id, code)
    );

    -- ============ 外部主键映射（OA-S6；OA-32 五元组唯一） ============
    CREATE TABLE external_mapping (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      source_system text NOT NULL,
      organization_code text NOT NULL,
      object_type text NOT NULL,
      external_id text NOT NULL,
      line_no integer NOT NULL DEFAULT 1,
      local_object_type text NOT NULL,
      local_object_id uuid NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now(),
      created_by text,
      updated_at timestamptz NOT NULL DEFAULT now(),
      updated_by text,
      CONSTRAINT external_mapping_quintuple_unique
        UNIQUE (source_system, organization_code, object_type, external_id, line_no)
    );
    CREATE INDEX external_mapping_object_idx ON external_mapping (local_object_type, local_object_id);
  `,
  down: /* sql */ `
    DROP TABLE IF EXISTS external_mapping;
    DROP TABLE IF EXISTS shift_calendar;
    DROP TABLE IF EXISTS auth_session;
    DROP TABLE IF EXISTS scope_grant;
    DROP TABLE IF EXISTS user_account;
    DROP TABLE IF EXISTS role;
    DROP TABLE IF EXISTS org_node;
  `,
}
