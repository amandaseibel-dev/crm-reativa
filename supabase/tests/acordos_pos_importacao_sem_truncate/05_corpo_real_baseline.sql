-- CORPO REAL DA FUNÇÃO -- não é stand-in.
--
-- Capturado de PRODUÇÃO (`ahattpqrjmhkzsmnbdzs`, PostgreSQL 17.6) em
-- 08/11/2026 por `pg_get_functiondef()`, somente leitura:
--   md5    1a0bf629927d3c6bbfcca01d3e8cab87
--   bytes  4690
--   linhas 101
--
-- POR QUE ESTE ARQUIVO EXISTE: `02_baseline.sql` usa um stand-in simplificado.
-- Ele prova o COMPORTAMENTO (a tabela nasce esvaziável e deixa de nascer), mas
-- não prova que o patch de texto sobrevive ao corpo de verdade -- 101 linhas,
-- com `format()`, dollar-quote, regex com barra invertida e seis `execute`.
-- Aqui o alvo é o texto real, byte a byte.
--
-- A função NUNCA é executada neste teste: o patch mexe no texto, não na
-- lógica. Por isso as tabelas e funções que o corpo cita (`pagamentos`,
-- `parcelas`, `acordos`, `acordo_titulo_vinculo`, `auth.role()`,
-- `recalcular_situacao_aluno`) não precisam existir -- plpgsql só confere
-- sintaxe na criação. Criar dublê delas provaria menos e divergiria mais.
\set ON_ERROR_STOP on

create table if not exists public._prova_corpo_real (
  etapa text primary key,
  md5   text not null,
  bytes int  not null
);

-- ---------------------------------------------------------------------------
-- O corpo real, exatamente como veio do catálogo de produção.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.acordos_pos_importacao(p_importacao_id uuid DEFAULT NULL::uuid, p_confirmar boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
 SET statement_timeout TO '600s'
AS $function$
declare
  v_pagos int := 0; v_amarrados int := 0; v_vinculados int := 0; v_alunos int := 0;
  v_valor_pago numeric := 0; v_valor_vinc numeric := 0; v_lote text;
begin
  if coalesce(current_setting('reativa.fluxo_pagamentos', true),'') <> 'on'
     and coalesce(auth.role(),'') <> 'service_role'
     and not public.usuario_e_gestao() then
    raise exception 'Acesso negado: somente gestao financeira.' using errcode='42501';
  end if;

  create temp table _alvo on commit drop as
  select t.id, t.aluno_id, t.documento, ltrim(t.documento,'0') chave,
         (right(t.documento,4))::int nr,
         coalesce(t.saldo_corrigido,t.valor_em_aberto,t.valor_original,0) valor
    from public.acordos_titulos t
   where coalesce(t.tipo_boleto,'')='Acordo'
     and upper(coalesce(t.situacao,''))='ABERTO'
     and t.documento ~ '^\d{12}$'
     and (p_importacao_id is null or t.importacao_id = p_importacao_id)
     and not exists (select 1 from public.acordo_titulo_vinculo v
                      where v.titulo_id=t.id and coalesce(v.ativo,true));

  create temp table _pago on commit drop as
  select distinct a.id, a.aluno_id, a.valor, p.data_pagamento
    from _alvo a join public.pagamentos p
      on ltrim(coalesce(p.numero_parcela_completo,''),'0') = a.chave;

  create temp table _casa on commit drop as
  select distinct on (a.id) a.id titulo_id, a.aluno_id, a.chave, a.valor,
         pa.id parcela_id, pa.acordo_id
    from _alvo a
    join public.acordos ac on ac.aluno_id = a.aluno_id
    join public.parcelas pa on pa.acordo_id = ac.id and pa.numero = a.nr
   where not exists (select 1 from _pago pg where pg.id = a.id)
     and abs(pa.valor - a.valor) <= 0.05
     and pa.boleto is null
   order by a.id, abs(pa.valor - a.valor);

  select count(*), round(coalesce(sum(valor),0),2) into v_pagos, v_valor_pago from _pago;
  select count(*), round(coalesce(sum(valor),0),2) into v_vinculados, v_valor_vinc from _casa;
  select count(distinct aluno_id) into v_alunos
    from (select aluno_id from _pago union select aluno_id from _casa) x;

  if not coalesce(p_confirmar,false) then
    return jsonb_build_object('modo','previa',
      'titulos_no_alvo', (select count(*) from _alvo),
      'ja_pagos_no_extrato', v_pagos, 'valor_ja_pago', v_valor_pago,
      'casam_com_parcela', v_vinculados, 'valor_a_vincular', v_valor_vinc,
      'sobram_sem_tratamento',
        (select count(*) from _alvo a where not exists (select 1 from _pago p where p.id=a.id)
           and not exists (select 1 from _casa c where c.titulo_id=a.id)),
      'alunos', v_alunos);
  end if;

  v_lote := to_char(clock_timestamp(),'YYYYMMDDHH24MISS');
  execute format('create table if not exists public.%I as
     select t.*, now() salvo_em from public.acordos_titulos t
      where t.id in (select id from _alvo)', '_backup_pos_import_' || v_lote);
  execute format('alter table public.%I enable row level security', '_backup_pos_import_' || v_lote);

  update public.acordos_titulos t
     set situacao='PAGO', status='quitada',
         motivo_ajuste = coalesce(t.motivo_ajuste,'')
           || case when coalesce(t.motivo_ajuste,'')='' then '' else ' | ' end
           || 'importado em aberto, mas o extrato Santander mostra pagamento do documento '
           || t.documento,
         atualizado_em = now()
    from _pago p where p.id = t.id;
  get diagnostics v_pagos = row_count;

  update public.parcelas pa set boleto = c.chave, atualizado_em = now()
    from _casa c where pa.id = c.parcela_id and pa.boleto is null;
  get diagnostics v_amarrados = row_count;

  insert into public.acordo_titulo_vinculo (acordo_id, titulo_id, ativo)
  select c.acordo_id, c.titulo_id, true from _casa c
   where not exists (select 1 from public.acordo_titulo_vinculo v
                      where v.titulo_id=c.titulo_id and v.acordo_id=c.acordo_id);

  update public.acordos_titulos t
     set situacao='NEGOCIADO', status='vinculada', acordo_id = c.acordo_id, atualizado_em = now()
    from _casa c where t.id = c.titulo_id;
  get diagnostics v_vinculados = row_count;

  perform public.recalcular_situacao_aluno(x.aluno_id)
     from (select aluno_id from _pago union select aluno_id from _casa) x;

  return jsonb_build_object('modo','aplicado','lote', v_lote,
    'marcados_pagos', v_pagos, 'boletos_amarrados', v_amarrados,
    'vinculados', v_vinculados, 'alunos', v_alunos,
    'backup', '_backup_pos_import_' || v_lote);
end;
$function$;

-- ACL de EXECUTE como em produção, medido em 08/11/2026:
--   {postgres=X/postgres,authenticated=X/postgres,service_role=X/postgres}
-- Sem PUBLIC. A migration guarda que este ACL não muda.
revoke all on function public.acordos_pos_importacao(uuid, boolean) from public;
grant execute on function public.acordos_pos_importacao(uuid, boolean) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Prova 1 -- FIDELIDADE. O texto que o catálogo deste Postgres devolve tem de
-- ser idêntico ao de produção. Se esta prova falhar, o teste está medindo
-- outra coisa, e nada do que vem depois vale.
-- ---------------------------------------------------------------------------
do $prova$
declare
  v_def  text;
  v_md5  text;
  v_esperado constant text := '1a0bf629927d3c6bbfcca01d3e8cab87';
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'acordos_pos_importacao';

  v_md5 := md5(v_def);

  insert into public._prova_corpo_real (etapa, md5, bytes)
  values ('antes', v_md5, length(v_def))
  on conflict (etapa) do update set md5 = excluded.md5, bytes = excluded.bytes;

  if v_md5 <> v_esperado then
    raise exception
      'INFIEL: o corpo neste banco nao e o de producao. md5 esperado %, obtido % (% bytes, servidor %)',
      v_esperado, v_md5, length(v_def), current_setting('server_version');
  end if;

  raise notice 'FIEL: corpo real reproduzido byte a byte -- md5 %, % bytes, servidor %',
    v_md5, length(v_def), current_setting('server_version');
end
$prova$;

-- ---------------------------------------------------------------------------
-- Prova 2 -- a âncora da migration existe EXATAMENTE UMA vez no corpo real.
-- É a Guarda 2 da migration, conferida aqui antes de a migration rodar.
-- ---------------------------------------------------------------------------
do $prova$
declare
  v_def text;
  v_ancora constant text :=
    'execute format(''alter table public.%I enable row level security'', ''_backup_pos_import_'' || v_lote);';
  v_n int;
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'acordos_pos_importacao';

  v_n := (length(v_def) - length(replace(v_def, v_ancora, ''))) / length(v_ancora);
  if v_n <> 1 then
    raise exception 'ancora aparece % vez(es) no corpo real, esperado 1', v_n;
  end if;
  raise notice 'ancora presente 1 vez no corpo real';
end
$prova$;
