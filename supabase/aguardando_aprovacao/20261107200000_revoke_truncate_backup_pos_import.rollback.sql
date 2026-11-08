-- ROLLBACK de 20261107200000_revoke_truncate_backup_pos_import
--
-- Restaura o privilégio TRUNCATE de `authenticated` nas MESMAS 545 tabelas,
-- devolvendo o ACL ao estado original medido em 07/11/2026:
--   `authenticated=arwdDxtm/postgres`
--
-- BASE DO ROLLBACK -- grants originais, não suposição. Medido em PROD em
-- 07/11/2026, antes de qualquer alteração, por `aclexplode(relacl)`:
--   · as 545 tinham ACL **idêntico**, letra por letra:
--       postgres=arwdDxtm/postgres | authenticated=arwdDxtm/postgres |
--       service_role=arwdDxtm/postgres
--   · `a`=INSERT `r`=SELECT `w`=UPDATE `d`=DELETE `D`=TRUNCATE
--     `x`=REFERENCES `t`=TRIGGER `m`=MAINTAIN
--   · o revoke retira **só** o `D`. Logo, devolver o `D` com `grant truncate`
--     recompõe `arwdDxtm` exatamente -- não é aproximação.
--
-- As três tabelas que nunca tiveram grant a `authenticated` seguem fora da
-- lista, aqui como lá:
--   _backup_pos_import_20260831225215
--   _backup_pos_import_20260831232000
--   _backup_pos_import_20260901085846
-- Conceder TRUNCATE a elas seria **ampliar** acesso, não reverter.
--
-- QUANDO USAR: se o revoke quebrar alguma rotina não prevista. A auditoria de
-- 07/11/2026 não encontrou nenhuma (nenhuma função executa TRUNCATE, nenhum
-- cron, nenhum trigger, e `acordos_pos_importacao` é SECURITY DEFINER com
-- owner `postgres`), então este arquivo existe por disciplina, não por
-- expectativa de uso.
--
-- NÃO RESTAURA NADA ALÉM DISSO: não mexe em RLS, policy, dado ou qualquer
-- outro privilégio -- porque a migration também não mexeu.

begin;

-- Guarda: o conjunto ainda é o mesmo 545? (agora SEM TRUNCATE, por efeito da
-- migration -- é isso que se espera encontrar antes de reverter)
do $guarda$
declare
  v_total integer;
  v_md5   text;
  v_com_truncate integer;
begin
  select count(*), md5(string_agg(c.relname, ',' order by c.relname))
    into v_total, v_md5
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relkind = 'r'
     and c.relname like '\_backup\_pos\_import\_%'
     and exists (select 1 from aclexplode(c.relacl) x
                  join pg_roles r on r.oid = x.grantee
                 where r.rolname = 'authenticated');

  if v_total <> 545 or v_md5 <> 'e9368e7cd2d8095423234387ace01018' then
    raise exception
      'conjunto divergente: % tabelas com grant a authenticated, md5 %. Esperado 545 / e9368e7cd2d8095423234387ace01018.',
      v_total, v_md5;
  end if;

  select count(*) into v_com_truncate
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relkind = 'r'
     and c.relname like '\_backup\_pos\_import\_%'
     and has_table_privilege('authenticated', c.oid, 'TRUNCATE');

  if v_com_truncate <> 0 then
    raise notice 'atencao: % tabelas JA tinham TRUNCATE antes do rollback -- o grant abaixo e no-op nelas', v_com_truncate;
  end if;
end
$guarda$;

-- Fotografia antes do grant, para provar que só o TRUNCATE volta.
do $snapshot$
begin
  create temp table _seg_antes on commit drop as
  select c.oid,
         c.relname,
         c.relrowsecurity,
         (select a::text from unnest(c.relacl) a
           where a::text like 'authenticated=%') as acl_auth
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relkind = 'r';

  create index on _seg_antes (oid);
end
$snapshot$;

grant truncate on table
  public."_backup_pos_import_20260831",
  public."_backup_pos_import_20260901130404",
  public."_backup_pos_import_20260901134000",
  public."_backup_pos_import_20260901144000",
  public."_backup_pos_import_20260901154001",
  public."_backup_pos_import_20260901164000",
  public."_backup_pos_import_20260901174001",
  public."_backup_pos_import_20260901184000",
  public."_backup_pos_import_20260901194000",
  public."_backup_pos_import_20260901204001",
  public."_backup_pos_import_20260901214000",
  public."_backup_pos_import_20260901224000",
  public."_backup_pos_import_20260901234000",
  public."_backup_pos_import_20260902004000",
  public."_backup_pos_import_20260902014000",
  public."_backup_pos_import_20260902024000",
  public."_backup_pos_import_20260902034000",
  public."_backup_pos_import_20260902044000",
  public."_backup_pos_import_20260902054000",
  public."_backup_pos_import_20260902064000",
  public."_backup_pos_import_20260902074000",
  public."_backup_pos_import_20260902084000",
  public."_backup_pos_import_20260902094000",
  public."_backup_pos_import_20260902104000",
  public."_backup_pos_import_20260902114000",
  public."_backup_pos_import_20260902124001",
  public."_backup_pos_import_20260902134000",
  public."_backup_pos_import_20260902144000",
  public."_backup_pos_import_20260902154000",
  public."_backup_pos_import_20260902164000",
  public."_backup_pos_import_20260902174000",
  public."_backup_pos_import_20260902184000",
  public."_backup_pos_import_20260902194000",
  public."_backup_pos_import_20260902204000",
  public."_backup_pos_import_20260902214000",
  public."_backup_pos_import_20260902224001",
  public."_backup_pos_import_20260902234000",
  public."_backup_pos_import_20260903004000",
  public."_backup_pos_import_20260903014001",
  public."_backup_pos_import_20260903024000",
  public."_backup_pos_import_20260903034000",
  public."_backup_pos_import_20260903044001",
  public."_backup_pos_import_20260903054001",
  public."_backup_pos_import_20260903064000",
  public."_backup_pos_import_20260903074000",
  public."_backup_pos_import_20260903084000",
  public."_backup_pos_import_20260903094000",
  public."_backup_pos_import_20260903104001",
  public."_backup_pos_import_20260903114000",
  public."_backup_pos_import_20260903124000",
  public."_backup_pos_import_20260903134000",
  public."_backup_pos_import_20260903144000",
  public."_backup_pos_import_20260903154000",
  public."_backup_pos_import_20260903164000",
  public."_backup_pos_import_20260903174000",
  public."_backup_pos_import_20260903184000",
  public."_backup_pos_import_20260903194000",
  public."_backup_pos_import_20260903204000",
  public."_backup_pos_import_20260903214001",
  public."_backup_pos_import_20260903224000",
  public."_backup_pos_import_20260903234000",
  public."_backup_pos_import_20260904004001",
  public."_backup_pos_import_20260904014000",
  public."_backup_pos_import_20260904024002",
  public."_backup_pos_import_20260904034000",
  public."_backup_pos_import_20260904044000",
  public."_backup_pos_import_20260904054000",
  public."_backup_pos_import_20260904064000",
  public."_backup_pos_import_20260904074000",
  public."_backup_pos_import_20260904084001",
  public."_backup_pos_import_20260904094002",
  public."_backup_pos_import_20260904104001",
  public."_backup_pos_import_20260904114002",
  public."_backup_pos_import_20260904124000",
  public."_backup_pos_import_20260904134000",
  public."_backup_pos_import_20260904144001",
  public."_backup_pos_import_20260904154000",
  public."_backup_pos_import_20260904164000",
  public."_backup_pos_import_20260904174001",
  public."_backup_pos_import_20260904184000",
  public."_backup_pos_import_20260904194001",
  public."_backup_pos_import_20260904204001",
  public."_backup_pos_import_20260904214000",
  public."_backup_pos_import_20260904224000",
  public."_backup_pos_import_20260904234001",
  public."_backup_pos_import_20260905004000",
  public."_backup_pos_import_20260905014000",
  public."_backup_pos_import_20260905024001",
  public."_backup_pos_import_20260905034001",
  public."_backup_pos_import_20260905044001",
  public."_backup_pos_import_20260905054000",
  public."_backup_pos_import_20260905064001",
  public."_backup_pos_import_20260905074000",
  public."_backup_pos_import_20260905084000",
  public."_backup_pos_import_20260905094000",
  public."_backup_pos_import_20260905104000",
  public."_backup_pos_import_20260905114000",
  public."_backup_pos_import_20260905124000",
  public."_backup_pos_import_20260905134000",
  public."_backup_pos_import_20260905144000",
  public."_backup_pos_import_20260905154000",
  public."_backup_pos_import_20260905164000",
  public."_backup_pos_import_20260905174000",
  public."_backup_pos_import_20260905184000",
  public."_backup_pos_import_20260905194000",
  public."_backup_pos_import_20260905204000",
  public."_backup_pos_import_20260905214000",
  public."_backup_pos_import_20260905224000",
  public."_backup_pos_import_20260905234000",
  public."_backup_pos_import_20260906004000",
  public."_backup_pos_import_20260906014000",
  public."_backup_pos_import_20260906024000",
  public."_backup_pos_import_20260906034000",
  public."_backup_pos_import_20260906044000",
  public."_backup_pos_import_20260906054000",
  public."_backup_pos_import_20260906064000",
  public."_backup_pos_import_20260906074000",
  public."_backup_pos_import_20260906084000",
  public."_backup_pos_import_20260906094000",
  public."_backup_pos_import_20260906104000",
  public."_backup_pos_import_20260906114000",
  public."_backup_pos_import_20260906124000",
  public."_backup_pos_import_20260906134000",
  public."_backup_pos_import_20260906144000",
  public."_backup_pos_import_20260906154000",
  public."_backup_pos_import_20260906164000",
  public."_backup_pos_import_20260906174000",
  public."_backup_pos_import_20260906184000",
  public."_backup_pos_import_20260906194000",
  public."_backup_pos_import_20260906204000",
  public."_backup_pos_import_20260906214000",
  public."_backup_pos_import_20260906224000",
  public."_backup_pos_import_20260906234000",
  public."_backup_pos_import_20260907004000",
  public."_backup_pos_import_20260907014000",
  public."_backup_pos_import_20260907024000",
  public."_backup_pos_import_20260907034000",
  public."_backup_pos_import_20260907044000",
  public."_backup_pos_import_20260907054000",
  public."_backup_pos_import_20260907064000",
  public."_backup_pos_import_20260907074000",
  public."_backup_pos_import_20260907084000",
  public."_backup_pos_import_20260907094000",
  public."_backup_pos_import_20260907104000",
  public."_backup_pos_import_20260907114000",
  public."_backup_pos_import_20260907124000",
  public."_backup_pos_import_20260907134000",
  public."_backup_pos_import_20260907144000",
  public."_backup_pos_import_20260907154000",
  public."_backup_pos_import_20260907164000",
  public."_backup_pos_import_20260907174000",
  public."_backup_pos_import_20260907184000",
  public."_backup_pos_import_20260907194000",
  public."_backup_pos_import_20260907204000",
  public."_backup_pos_import_20260907214000",
  public."_backup_pos_import_20260907224000",
  public."_backup_pos_import_20260907234000",
  public."_backup_pos_import_20260908004000",
  public."_backup_pos_import_20260908014000",
  public."_backup_pos_import_20260908024000",
  public."_backup_pos_import_20260908034000",
  public."_backup_pos_import_20260908044000",
  public."_backup_pos_import_20260908054000",
  public."_backup_pos_import_20260908064000",
  public."_backup_pos_import_20260908074000",
  public."_backup_pos_import_20260908084000",
  public."_backup_pos_import_20260908094000",
  public."_backup_pos_import_20260908104000",
  public."_backup_pos_import_20260908114000",
  public."_backup_pos_import_20260908124000",
  public."_backup_pos_import_20260908134000",
  public."_backup_pos_import_20260908144001",
  public."_backup_pos_import_20260908154010",
  public."_backup_pos_import_20260908164013",
  public."_backup_pos_import_20260908174014",
  public."_backup_pos_import_20260908184019",
  public."_backup_pos_import_20260908194015",
  public."_backup_pos_import_20260908204013",
  public."_backup_pos_import_20260908214010",
  public."_backup_pos_import_20260908224014",
  public."_backup_pos_import_20260908234011",
  public."_backup_pos_import_20260909004013",
  public."_backup_pos_import_20260909014011",
  public."_backup_pos_import_20260909024011",
  public."_backup_pos_import_20260909034011",
  public."_backup_pos_import_20260909044011",
  public."_backup_pos_import_20260909054011",
  public."_backup_pos_import_20260909064011",
  public."_backup_pos_import_20260909074012",
  public."_backup_pos_import_20260909084011",
  public."_backup_pos_import_20260909092147",
  public."_backup_pos_import_20260909092303",
  public."_backup_pos_import_20260909094013",
  public."_backup_pos_import_20260909104011",
  public."_backup_pos_import_20260909114014",
  public."_backup_pos_import_20260909124014",
  public."_backup_pos_import_20260909134015",
  public."_backup_pos_import_20260909144014",
  public."_backup_pos_import_20260909154012",
  public."_backup_pos_import_20260909164014",
  public."_backup_pos_import_20260909174019",
  public."_backup_pos_import_20260909184021",
  public."_backup_pos_import_20260909194026",
  public."_backup_pos_import_20260909204017",
  public."_backup_pos_import_20260909214016",
  public."_backup_pos_import_20260909224016",
  public."_backup_pos_import_20260909234013",
  public."_backup_pos_import_20260910004016",
  public."_backup_pos_import_20260910014012",
  public."_backup_pos_import_20260910024015",
  public."_backup_pos_import_20260910034012",
  public."_backup_pos_import_20260910044013",
  public."_backup_pos_import_20260910054012",
  public."_backup_pos_import_20260910064012",
  public."_backup_pos_import_20260910074013",
  public."_backup_pos_import_20260910084012",
  public."_backup_pos_import_20260910094015",
  public."_backup_pos_import_20260910104013",
  public."_backup_pos_import_20260910114021",
  public."_backup_pos_import_20260910124018",
  public."_backup_pos_import_20260910134020",
  public."_backup_pos_import_20260910144018",
  public."_backup_pos_import_20260910154016",
  public."_backup_pos_import_20260910164015",
  public."_backup_pos_import_20260910174018",
  public."_backup_pos_import_20260910184017",
  public."_backup_pos_import_20260910194017",
  public."_backup_pos_import_20260910204017",
  public."_backup_pos_import_20260910214016",
  public."_backup_pos_import_20260910224022",
  public."_backup_pos_import_20260910234013",
  public."_backup_pos_import_20260911004015",
  public."_backup_pos_import_20260911014017",
  public."_backup_pos_import_20260911024013",
  public."_backup_pos_import_20260911034013",
  public."_backup_pos_import_20260911044013",
  public."_backup_pos_import_20260911054013",
  public."_backup_pos_import_20260911064017",
  public."_backup_pos_import_20260911074016",
  public."_backup_pos_import_20260911084016",
  public."_backup_pos_import_20260911094014",
  public."_backup_pos_import_20260911104013",
  public."_backup_pos_import_20260911114016",
  public."_backup_pos_import_20260911124015",
  public."_backup_pos_import_20260911134016",
  public."_backup_pos_import_20260911144019",
  public."_backup_pos_import_20260911154020",
  public."_backup_pos_import_20260911164034",
  public."_backup_pos_import_20260911174023",
  public."_backup_pos_import_20260911184133",
  public."_backup_pos_import_20260911194015",
  public."_backup_pos_import_20260911204017",
  public."_backup_pos_import_20260911214021",
  public."_backup_pos_import_20260911224017",
  public."_backup_pos_import_20260911234016",
  public."_backup_pos_import_20260912004017",
  public."_backup_pos_import_20260912014014",
  public."_backup_pos_import_20260912024015",
  public."_backup_pos_import_20260912034017",
  public."_backup_pos_import_20260912044015",
  public."_backup_pos_import_20260912054014",
  public."_backup_pos_import_20260912064014",
  public."_backup_pos_import_20260912074016",
  public."_backup_pos_import_20260912084014",
  public."_backup_pos_import_20260912094014",
  public."_backup_pos_import_20260912104014",
  public."_backup_pos_import_20260912114014",
  public."_backup_pos_import_20260912124018",
  public."_backup_pos_import_20260912134016",
  public."_backup_pos_import_20260912144016",
  public."_backup_pos_import_20260912154017",
  public."_backup_pos_import_20260912164014",
  public."_backup_pos_import_20260912174015",
  public."_backup_pos_import_20260912184014",
  public."_backup_pos_import_20260912194014",
  public."_backup_pos_import_20260912204014",
  public."_backup_pos_import_20260912214013",
  public."_backup_pos_import_20260912224013",
  public."_backup_pos_import_20260912234014",
  public."_backup_pos_import_20260913004016",
  public."_backup_pos_import_20260913014019",
  public."_backup_pos_import_20260913024016",
  public."_backup_pos_import_20260913034018",
  public."_backup_pos_import_20260913044015",
  public."_backup_pos_import_20260913054014",
  public."_backup_pos_import_20260913064016",
  public."_backup_pos_import_20260913074014",
  public."_backup_pos_import_20260913084014",
  public."_backup_pos_import_20260913094016",
  public."_backup_pos_import_20260913104014",
  public."_backup_pos_import_20260913114014",
  public."_backup_pos_import_20260913124014",
  public."_backup_pos_import_20260913134016",
  public."_backup_pos_import_20260913144014",
  public."_backup_pos_import_20260913154014",
  public."_backup_pos_import_20260913164014",
  public."_backup_pos_import_20260913174015",
  public."_backup_pos_import_20260913184016",
  public."_backup_pos_import_20260913194014",
  public."_backup_pos_import_20260913204017",
  public."_backup_pos_import_20260913214015",
  public."_backup_pos_import_20260913224014",
  public."_backup_pos_import_20260913234014",
  public."_backup_pos_import_20260914004017",
  public."_backup_pos_import_20260914014016",
  public."_backup_pos_import_20260914024013",
  public."_backup_pos_import_20260914034014",
  public."_backup_pos_import_20260914044014",
  public."_backup_pos_import_20260914054014",
  public."_backup_pos_import_20260914064014",
  public."_backup_pos_import_20260914074014",
  public."_backup_pos_import_20260914084016",
  public."_backup_pos_import_20260914094014",
  public."_backup_pos_import_20260914104014",
  public."_backup_pos_import_20260914114013",
  public."_backup_pos_import_20260914124019",
  public."_backup_pos_import_20260914134014",
  public."_backup_pos_import_20260914144016",
  public."_backup_pos_import_20260914154019",
  public."_backup_pos_import_20260914174016",
  public."_backup_pos_import_20260914184016",
  public."_backup_pos_import_20260914194015",
  public."_backup_pos_import_20260914204015",
  public."_backup_pos_import_20260914214017",
  public."_backup_pos_import_20260914224015",
  public."_backup_pos_import_20260914234014",
  public."_backup_pos_import_20260915004014",
  public."_backup_pos_import_20260915014013",
  public."_backup_pos_import_20260915024013",
  public."_backup_pos_import_20260915034014",
  public."_backup_pos_import_20260915044014",
  public."_backup_pos_import_20260915054013",
  public."_backup_pos_import_20260915064014",
  public."_backup_pos_import_20260915074013",
  public."_backup_pos_import_20260915084014",
  public."_backup_pos_import_20260915094014",
  public."_backup_pos_import_20260915104014",
  public."_backup_pos_import_20260915114013",
  public."_backup_pos_import_20260915124015",
  public."_backup_pos_import_20260915134013",
  public."_backup_pos_import_20260915144015",
  public."_backup_pos_import_20260915154014",
  public."_backup_pos_import_20260915164017",
  public."_backup_pos_import_20260915174015",
  public."_backup_pos_import_20260915184018",
  public."_backup_pos_import_20260915194020",
  public."_backup_pos_import_20260915204020",
  public."_backup_pos_import_20260915214016",
  public."_backup_pos_import_20260915224017",
  public."_backup_pos_import_20260915234015",
  public."_backup_pos_import_20260916004014",
  public."_backup_pos_import_20260916014014",
  public."_backup_pos_import_20260916024014",
  public."_backup_pos_import_20260916034014",
  public."_backup_pos_import_20260916044016",
  public."_backup_pos_import_20260916054014",
  public."_backup_pos_import_20260916064016",
  public."_backup_pos_import_20260916074014",
  public."_backup_pos_import_20260916084016",
  public."_backup_pos_import_20260916094014",
  public."_backup_pos_import_20260916104014",
  public."_backup_pos_import_20260916114015",
  public."_backup_pos_import_20260916124016",
  public."_backup_pos_import_20260916134016",
  public."_backup_pos_import_20260916144016",
  public."_backup_pos_import_20260916154017",
  public."_backup_pos_import_20260916164016",
  public."_backup_pos_import_20260916174106",
  public."_backup_pos_import_20260916184102",
  public."_backup_pos_import_20260916194018",
  public."_backup_pos_import_20260916204020",
  public."_backup_pos_import_20260916214018",
  public."_backup_pos_import_20260916224020",
  public."_backup_pos_import_20260916234015",
  public."_backup_pos_import_20260917004017",
  public."_backup_pos_import_20260917014018",
  public."_backup_pos_import_20260917024014",
  public."_backup_pos_import_20260917034016",
  public."_backup_pos_import_20260917044015",
  public."_backup_pos_import_20260917054015",
  public."_backup_pos_import_20260917064017",
  public."_backup_pos_import_20260917074015",
  public."_backup_pos_import_20260917084015",
  public."_backup_pos_import_20260917094014",
  public."_backup_pos_import_20260917104015",
  public."_backup_pos_import_20260917114018",
  public."_backup_pos_import_20260917124016",
  public."_backup_pos_import_20260917134019",
  public."_backup_pos_import_20260917144019",
  public."_backup_pos_import_20260917154022",
  public."_backup_pos_import_20260917174144",
  public."_backup_pos_import_20260917184017",
  public."_backup_pos_import_20260917194019",
  public."_backup_pos_import_20260917204023",
  public."_backup_pos_import_20260917214019",
  public."_backup_pos_import_20260917224017",
  public."_backup_pos_import_20260917234016",
  public."_backup_pos_import_20260918004016",
  public."_backup_pos_import_20260918014017",
  public."_backup_pos_import_20260918024017",
  public."_backup_pos_import_20260918034016",
  public."_backup_pos_import_20260918044016",
  public."_backup_pos_import_20260918054017",
  public."_backup_pos_import_20260918064017",
  public."_backup_pos_import_20260918074017",
  public."_backup_pos_import_20260918084016",
  public."_backup_pos_import_20260918094018",
  public."_backup_pos_import_20260918095505",
  public."_backup_pos_import_20260918104016",
  public."_backup_pos_import_20260918114017",
  public."_backup_pos_import_20260918124018",
  public."_backup_pos_import_20260918134020",
  public."_backup_pos_import_20260918144017",
  public."_backup_pos_import_20260918154018",
  public."_backup_pos_import_20260918164021",
  public."_backup_pos_import_20260918184021",
  public."_backup_pos_import_20260918194019",
  public."_backup_pos_import_20260918204020",
  public."_backup_pos_import_20260918214020",
  public."_backup_pos_import_20260918224022",
  public."_backup_pos_import_20260918234018",
  public."_backup_pos_import_20260919004016",
  public."_backup_pos_import_20260919014017",
  public."_backup_pos_import_20260919024018",
  public."_backup_pos_import_20260919034019",
  public."_backup_pos_import_20260919044018",
  public."_backup_pos_import_20260919054016",
  public."_backup_pos_import_20260919064017",
  public."_backup_pos_import_20260919074018",
  public."_backup_pos_import_20260919084018",
  public."_backup_pos_import_20260919094017",
  public."_backup_pos_import_20260919104017",
  public."_backup_pos_import_20260919114019",
  public."_backup_pos_import_20260919134021",
  public."_backup_pos_import_20260919144023",
  public."_backup_pos_import_20260919154021",
  public."_backup_pos_import_20260919164017",
  public."_backup_pos_import_20260919174017",
  public."_backup_pos_import_20260919184017",
  public."_backup_pos_import_20260919194018",
  public."_backup_pos_import_20260919204018",
  public."_backup_pos_import_20260919214018",
  public."_backup_pos_import_20260919224017",
  public."_backup_pos_import_20260919234019",
  public."_backup_pos_import_20260920004019",
  public."_backup_pos_import_20260920014019",
  public."_backup_pos_import_20260920024017",
  public."_backup_pos_import_20260920034019",
  public."_backup_pos_import_20260920044019",
  public."_backup_pos_import_20260920054019",
  public."_backup_pos_import_20260920064019",
  public."_backup_pos_import_20260920074019",
  public."_backup_pos_import_20260920084018",
  public."_backup_pos_import_20260920094019",
  public."_backup_pos_import_20260920104023",
  public."_backup_pos_import_20260920114019",
  public."_backup_pos_import_20260920124018",
  public."_backup_pos_import_20260920144017",
  public."_backup_pos_import_20260920154017",
  public."_backup_pos_import_20260920164019",
  public."_backup_pos_import_20260920174016",
  public."_backup_pos_import_20260920184016",
  public."_backup_pos_import_20260920194016",
  public."_backup_pos_import_20260920204017",
  public."_backup_pos_import_20260920214018",
  public."_backup_pos_import_20260920224016",
  public."_backup_pos_import_20260920234020",
  public."_backup_pos_import_20260921004017",
  public."_backup_pos_import_20260921014016",
  public."_backup_pos_import_20260921024018",
  public."_backup_pos_import_20260921034017",
  public."_backup_pos_import_20260921044019",
  public."_backup_pos_import_20260921054018",
  public."_backup_pos_import_20260921064016",
  public."_backup_pos_import_20260921074017",
  public."_backup_pos_import_20260921084018",
  public."_backup_pos_import_20260921094019",
  public."_backup_pos_import_20260921104018",
  public."_backup_pos_import_20260921114016",
  public."_backup_pos_import_20260921124018",
  public."_backup_pos_import_20260921134020",
  public."_backup_pos_import_20260921144020",
  public."_backup_pos_import_20260921154022",
  public."_backup_pos_import_20260921174110",
  public."_backup_pos_import_20260921184022",
  public."_backup_pos_import_20260921195327",
  public."_backup_pos_import_20260921214020",
  public."_backup_pos_import_20260921224023",
  public."_backup_pos_import_20260921234017",
  public."_backup_pos_import_20260922004020",
  public."_backup_pos_import_20260922014017",
  public."_backup_pos_import_20260922024019",
  public."_backup_pos_import_20260922034017",
  public."_backup_pos_import_20260922044018",
  public."_backup_pos_import_20260922054018",
  public."_backup_pos_import_20260922064018",
  public."_backup_pos_import_20260922074018",
  public."_backup_pos_import_20260922084017",
  public."_backup_pos_import_20260922094018",
  public."_backup_pos_import_20260922104019",
  public."_backup_pos_import_20260922114022",
  public."_backup_pos_import_20260922124102",
  public."_backup_pos_import_20260922144023",
  public."_backup_pos_import_20260922154024",
  public."_backup_pos_import_20260922194019",
  public."_backup_pos_import_20260922204021",
  public."_backup_pos_import_20260922214022",
  public."_backup_pos_import_20260922224024",
  public."_backup_pos_import_20260922234020",
  public."_backup_pos_import_20260923004017",
  public."_backup_pos_import_20260923014019",
  public."_backup_pos_import_20260923024018",
  public."_backup_pos_import_20260923034020",
  public."_backup_pos_import_20260923044020",
  public."_backup_pos_import_20260923054021",
  public."_backup_pos_import_20260923064018",
  public."_backup_pos_import_20260923074018",
  public."_backup_pos_import_20260923084018",
  public."_backup_pos_import_20260923094019",
  public."_backup_pos_import_20260923104018",
  public."_backup_pos_import_20260923114019",
  public."_backup_pos_import_20260923124023",
  public."_backup_pos_import_20260923134021",
  public."_backup_pos_import_20260923144022",
  public."_backup_pos_import_20260923164019",
  public."_backup_pos_import_20260923184049",
  public."_backup_pos_import_20260923214023",
  public."_backup_pos_import_20260923224019",
  public."_backup_pos_import_20260923234019",
  public."_backup_pos_import_20260924004021",
  public."_backup_pos_import_20260924014020",
  public."_backup_pos_import_20260924024020",
  public."_backup_pos_import_20260924034021",
  public."_backup_pos_import_20260924044021",
  public."_backup_pos_import_20260924054021",
  public."_backup_pos_import_20260924064020",
  public."_backup_pos_import_20260924074019",
  public."_backup_pos_import_20260924084021",
  public."_backup_pos_import_20260924094019",
  public."_backup_pos_import_20260924104019",
  public."_backup_pos_import_20260924114021",
  public."_backup_pos_import_20260924134021",
  public."_backup_pos_import_20260924144023",
  public."_backup_pos_import_20260924164031",
  public."_backup_pos_import_20260924174025"
to authenticated;

-- Conferência do rollback, na mesma transação, contra a fotografia.
--
-- Mesma régua da migration, pelo avesso: `replace(acl,'D','')` igual dos dois
-- lados prova que **só** o TRUNCATE voltou, sem depender de o servidor ter
-- `MAINTAIN` (PG17) ou não (PG16) nem da ordem das letras do ACL.
do $confere$
declare
  v_sem_truncate     integer;
  v_outro_privilegio integer;
  v_colateral        integer;
begin
  -- (a) as 545 têm de voltar a ter TRUNCATE
  select count(*) into v_sem_truncate
    from _seg_antes antes
    join pg_class c on c.oid = antes.oid
   where antes.acl_auth is not null
     and antes.relname like '\_backup\_pos\_import\_%'
     and not has_table_privilege('authenticated', c.oid, 'TRUNCATE');

  if v_sem_truncate <> 0 then
    raise exception 'rollback incompleto: % tabelas seguem sem TRUNCATE', v_sem_truncate;
  end if;

  -- (b) e nada além do TRUNCATE voltou
  select count(*) into v_outro_privilegio
    from _seg_antes antes
    join pg_class c on c.oid = antes.oid
   where antes.acl_auth is not null
     and antes.relname like '\_backup\_pos\_import\_%'
     and coalesce(replace((select a::text from unnest(c.relacl) a
                            where a::text like 'authenticated=%'), 'D', ''), '<ausente>')
         <> replace(antes.acl_auth, 'D', '');

  if v_outro_privilegio <> 0 then
    raise exception 'rollback mexeu em privilegio fora do alvo em % tabelas', v_outro_privilegio;
  end if;

  -- (c) nenhuma tabela fora do padrão foi tocada
  select count(*) into v_colateral
    from _seg_antes antes
    join pg_class c on c.oid = antes.oid
   where antes.relname not like '\_backup\_pos\_import\_%'
     and (select a::text from unnest(c.relacl) a
           where a::text like 'authenticated=%') is distinct from antes.acl_auth;

  if v_colateral <> 0 then
    raise exception 'dano colateral no rollback: % tabelas fora do padrao', v_colateral;
  end if;

  raise notice 'rollback OK: TRUNCATE restaurado nas 545; nenhum outro privilegio movido; 0 dano colateral';
end
$confere$;

commit;
