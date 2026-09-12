create table if not exists public._backup_fn_casos_reabrir_com_divida_20260912 as
select p.proname, p.prosrc, pg_get_functiondef(p.oid) as definicao_completa, now() as guardado_em
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.proname = 'casos_reabrir_com_divida';

alter table public._backup_fn_casos_reabrir_com_divida_20260912 enable row level security;
