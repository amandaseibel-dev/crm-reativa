-- Revisão de 100% dos casos do CRM contra o Prime: pendência na Reativa (195)
-- e no Santander (166), uma linha por aluno.
--
-- Pedido da Amanda (04/09/2026): "revisão de 100% dos casos do CRM no Prime;
-- se o aluno tem pendência Reativa ou Santander, em nenhum ou nos dois; pode
-- ser uma fila por aluno e 100% da base; se está matriculado em 2026/2 como
-- informação adicional".
--
-- DUAS LEITURAS, lado a lado, porque elas NÃO dizem a mesma coisa:
--
-- 1) PORTADOR (lista de alunos por portador, `prime_portador_membro`).
--    195 = ReATIVA Recuperação de Créditos, 166 = Santander ReATIVA. É a
--    leitura que a Amanda ditou em 25/08. MEDIDO em 04/09: a lista é
--    HISTÓRICA -- 97% dos alunos QUITADOS no CRM continuam nela. Estar na
--    lista prova que o aluno passou pelo portador, não que ainda deve.
--
-- 2) EXTRATO (título a título, `prime_extrato`, portador 195). O Prime devolve
--    `paymentDate` em 100% dos títulos, inclusive nos abertos. O que separa:
--      * título que o CRM importou como ABERTO em D e cuja "data de liquidação"
--        no Prime é ANTERIOR a D não foi pago -- o relatório de abertos da
--        própria Ulbra o listava aberto em D. 100% dos 16.448 títulos sem
--        negociação e com data antes do vencimento caem aqui; ZERO dos 1.747
--        pagamentos reais do extrato do Santander caem aqui.
--      * "data de liquidação" até 30 dias após o vencimento: mesma coisa
--        (2.718 títulos, 100% anteriores à importação; 0 pagamentos reais).
--      * fora disso, é liquidação de verdade (pagamento ou negociação).
--    Pendência Reativa = ao menos um título do 195 sem liquidação real.
--
-- 3) SANTANDER (166) o Prime nunca expõe a parcela do acordo. O sinal é a
--    lista do 166 cruzada com o acordo no CRM: ATIVO = pendência; QUITADO =
--    provável não; sem acordo/cancelado = indeterminado.
--
-- 4) MATRÍCULA 2026/2 pela janela do contrato (`prime_contratos`, valid_from
--    em jul-dez/2026), mesma regra de `aluno_matricula_semestres`.
--
-- A tabela é um retrato (data em `calculado_em`), recalculado por
-- `revisao_prime_recalcular()`. Só a gestão lê. A exportação em planilha sai
-- pela Edge Function `exportar-gestao`.
--
-- DESFAZER: supabase/rollbacks/20260904120000_revisao_prime_pendencia_por_aluno.rollback.sql

create table if not exists public.revisao_prime_aluno (
  aluno_id                      uuid primary key,
  nome                          text,
  cpf_mascarado                 text,
  matricula_crm                 text,
  matricula_prime               text,
  unidade                       text,
  curso                         text,
  operador                      text,
  caso_codigo                   integer,
  n_casos                       integer,
  situacao_crm                  text,
  saldo_crm                     numeric,
  crm_mens_abertas_n            integer,
  crm_mens_abertas_valor        numeric,
  crm_acordos_ativos_n          integer,
  crm_acordo_saldo              numeric,
  crm_acordos_quitados_n        integer,
  crm_acordos_cancelados_n      integer,
  prime_lista_195               boolean,
  prime_lista_166               boolean,
  prime_conhece                 boolean,
  prime_nao_devolve             boolean,
  extrato_coletado_em           date,
  p195_titulos                  integer,
  p195_abertos_n                integer,
  p195_abertos_valor            numeric,
  p195_abertos_venc_min         date,
  p195_abertos_venc_max         date,
  p195_abertos_fora_do_crm_n    integer,
  p195_abertos_fora_do_crm_valor numeric,
  p195_liquidados_n             integer,
  p195_ultima_liquidacao        date,
  crm_abertos_liquidados_no_prime_n     integer,
  crm_abertos_liquidados_no_prime_valor numeric,
  matricula_2026_2              text,
  curso_2026_2                  text,
  campus_2026_2                 text,
  portador_prime                text,
  pendencia_reativa             text,
  pendencia_santander           text,
  resumo                        text,
  calculado_em                  timestamptz not null default now()
);

comment on table public.revisao_prime_aluno is
  'Retrato da revisão CRM x Prime por aluno: portador (195/166), mensalidades do 195 sem liquidação real, acordo no CRM e matrícula 2026/2. Recalculado por revisao_prime_recalcular().';

alter table public.revisao_prime_aluno enable row level security;

drop policy if exists revisao_prime_aluno_gestao_le on public.revisao_prime_aluno;
create policy revisao_prime_aluno_gestao_le
  on public.revisao_prime_aluno for select
  to authenticated using (public.usuario_e_gestao());

revoke all on public.revisao_prime_aluno from public, anon;
grant select on public.revisao_prime_aluno to authenticated, service_role;
-- os privilegios padrao do projeto dao ALL a authenticated; aqui so leitura (a RLS ja barra escrita, mas o grant nao deve existir)
revoke insert, update, delete, truncate, references, trigger on public.revisao_prime_aluno from authenticated;

create index if not exists revisao_prime_aluno_resumo_idx on public.revisao_prime_aluno (resumo);

create or replace function public.revisao_prime_recalcular()
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_out jsonb;
begin
  if coalesce(auth.role(),'') <> 'service_role'
     and not public.usuario_e_gestao()
     and session_user <> 'postgres' then
    raise exception 'Acesso negado: restrito a gestao.' using errcode = '42501';
  end if;

  delete from public.revisao_prime_aluno;

  insert into public.revisao_prime_aluno (
    aluno_id, nome, cpf_mascarado, matricula_crm, matricula_prime, unidade, curso, operador,
    caso_codigo, n_casos, situacao_crm, saldo_crm,
    crm_mens_abertas_n, crm_mens_abertas_valor,
    crm_acordos_ativos_n, crm_acordo_saldo, crm_acordos_quitados_n, crm_acordos_cancelados_n,
    prime_lista_195, prime_lista_166, prime_conhece, prime_nao_devolve,
    extrato_coletado_em, p195_titulos, p195_abertos_n, p195_abertos_valor,
    p195_abertos_venc_min, p195_abertos_venc_max, p195_abertos_fora_do_crm_n, p195_abertos_fora_do_crm_valor,
    p195_liquidados_n, p195_ultima_liquidacao,
    crm_abertos_liquidados_no_prime_n, crm_abertos_liquidados_no_prime_valor,
    matricula_2026_2, curso_2026_2, campus_2026_2,
    portador_prime, pendencia_reativa, pendencia_santander, resumo, calculado_em)
  with al as (
    select a.id, a.nome, a.matricula, a.unidade,
           coalesce(nullif(a.curso_real,''), a.curso) as curso,
           coalesce(nullif(a.responsavel_atual_nome,''), nullif(a.operador_nome,''), nullif(a.operador,'')) as operador,
           a.situacao_operacional, a.saldo_total,
           regexp_replace(coalesce(a.cpf,''), '\D', '', 'g') as d
      from public.alunos a
     where exists (select 1 from public.casos c where c.aluno_id = a.id)
  ), cl as (
    select al.*,
           case when length(d) = 11 then d
                when length(d) between 9 and 10 then lpad(d, 11, '0') end as cpf11
      from al
  ), caso as (
    select x.aluno_id, x.caso_codigo, x.operador_nome, x.n_casos
      from (
        select c.aluno_id, c.caso_codigo, c.operador_nome,
               count(*) over (partition by c.aluno_id) as n_casos,
               row_number() over (partition by c.aluno_id
                                  order by c.encerrado_operacional asc nulls last,
                                           c.saldo_total desc nulls last,
                                           c.created_at desc) as rn
          from public.casos c
         where c.aluno_id is not null) x
     where x.rn = 1
  ), mens as (
    select t.aluno_id, count(*) as n,
           sum(coalesce(t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0)) as valor
      from public.acordos_titulos t
     where upper(coalesce(t.situacao,'')) = 'ABERTO'
       and lower(coalesce(t.status,'')) = 'em_aberto'
     group by t.aluno_id
  ), acs as (
    select a.aluno_id,
           count(*) filter (where a.status = 'ATIVO') as ativos,
           coalesce(sum(coalesce(a.saldo,0)) filter (where a.status = 'ATIVO'), 0) as saldo_ativo,
           count(*) filter (where a.status = 'QUITADO') as quitados,
           count(*) filter (where a.status = 'CANCELADO') as cancelados
      from public.acordos a
     group by a.aluno_id
  ), port as (
    select m.cpf, bool_or(m.portador = 195) as l195, bool_or(m.portador = 166) as l166
      from public.prime_portador_membro m
     group by m.cpf
  ), contr as (
    select c.cpf,
           max(c.registration) as registration,
           (array_agg(case when c.cancelado_em is not null then 'Cancelado' else coalesce(c.status,'—') end
              order by case when c.cancelado_em is not null then 3
                            when c.status = 'Confirmado' then 1
                            when c.status = 'Aberto' then 2 else 4 end, c.valid_from desc)
              filter (where c.valid_from between date '2026-07-01' and date '2026-12-31'))[1] as st_2026_2,
           (array_agg(c.curso
              order by case when c.cancelado_em is not null then 3
                            when c.status = 'Confirmado' then 1
                            when c.status = 'Aberto' then 2 else 4 end, c.valid_from desc)
              filter (where c.valid_from between date '2026-07-01' and date '2026-12-31'))[1] as curso_2026_2,
           (array_agg(c.campus
              order by case when c.cancelado_em is not null then 3
                            when c.status = 'Confirmado' then 1
                            when c.status = 'Aberto' then 2 else 4 end, c.valid_from desc)
              filter (where c.valid_from between date '2026-07-01' and date '2026-12-31'))[1] as campus_2026_2
      from public.prime_contratos c
     group by c.cpf
  ), tit as (
    -- Título a título no portador 195, com a regra de liquidação real.
    select e.cpf, e.boleto, e.vencimento, e.liquidado_em, e.valor_liquido, e.coletado_em,
           t.id as titulo_crm_id,
           (upper(coalesce(t.situacao,'')) = 'ABERTO' and lower(coalesce(t.status,'')) = 'em_aberto') as crm_aberto,
           coalesce(t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0) as crm_saldo,
           (e.liquidado_em is null
            or e.liquidado_em <= e.vencimento + 30
            or (t.created_at is not null and e.liquidado_em < t.created_at::date)) as aberto
      from public.prime_extrato e
      left join public.acordos_titulos t on t.documento = e.boleto
     where e.portador = 195
  ), ext as (
    select cpf,
           max(coletado_em)::date as coletado_em,
           count(*) as p195_titulos,
           count(*) filter (where aberto) as abertos_n,
           coalesce(sum(valor_liquido) filter (where aberto), 0) as abertos_valor,
           min(vencimento) filter (where aberto) as abertos_venc_min,
           max(vencimento) filter (where aberto) as abertos_venc_max,
           count(*) filter (where aberto and titulo_crm_id is null) as abertos_fora_crm_n,
           coalesce(sum(valor_liquido) filter (where aberto and titulo_crm_id is null), 0) as abertos_fora_crm_valor,
           count(*) filter (where not aberto) as liquidados_n,
           max(liquidado_em) filter (where not aberto) as ultima_liq,
           count(*) filter (where not aberto and crm_aberto) as crm_abertos_liq_n,
           coalesce(sum(crm_saldo) filter (where not aberto and crm_aberto), 0) as crm_abertos_liq_valor
      from tit
     group by cpf
  ), ext_qq as (
    select distinct e.cpf from public.prime_extrato e
  ), semret as (
    select s.cpf from public.prime_cadastro_sem_retorno s
  ), fila as (
    -- extrato pedido e devolvido (mesmo que sem titulo no 195): nao e "sem extrato"
    select f.cpf, max(f.coletado_em)::date as coletado_em
      from public.prime_extrato_fila f
     where f.coletado_em is not null and f.cpf is not null
     group by f.cpf
  ), base as (
    select cl.id as aluno_id, cl.nome,
           case when cl.cpf11 is null then null
                else '***.***.' || substr(cl.cpf11, 7, 3) || '-' || substr(cl.cpf11, 10, 2) end as cpf_mascarado,
           cl.matricula as matricula_crm, contr.registration as matricula_prime,
           cl.unidade, cl.curso,
           coalesce(cl.operador, caso.operador_nome) as operador,
           caso.caso_codigo, caso.n_casos,
           cl.situacao_operacional as situacao_crm, cl.saldo_total as saldo_crm,
           coalesce(mens.n, 0) as mens_n, coalesce(mens.valor, 0) as mens_valor,
           coalesce(acs.ativos, 0) as ativos, coalesce(acs.saldo_ativo, 0) as saldo_ativo,
           coalesce(acs.quitados, 0) as quitados, coalesce(acs.cancelados, 0) as cancelados,
           coalesce(port.l195, false) as l195, coalesce(port.l166, false) as l166,
           (cl.cpf11 is not null and (contr.cpf is not null or ext_qq.cpf is not null)) as conhece,
           (semret.cpf is not null) as nao_devolve,
           coalesce(ext.coletado_em, fila.coletado_em) as coletado_em, ext.p195_titulos, ext.abertos_n, ext.abertos_valor,
           ext.abertos_venc_min, ext.abertos_venc_max, ext.abertos_fora_crm_n, ext.abertos_fora_crm_valor,
           ext.liquidados_n, ext.ultima_liq, ext.crm_abertos_liq_n, ext.crm_abertos_liq_valor,
           (ext.cpf is not null or fila.cpf is not null) as tem_extrato,
           coalesce(contr.st_2026_2, case when contr.cpf is not null then 'Não' else 'sem cadastro no Prime' end) as st_2026_2,
           contr.curso_2026_2, contr.campus_2026_2,
           cl.cpf11
      from cl
      left join caso   on caso.aluno_id = cl.id
      left join mens   on mens.aluno_id = cl.id
      left join acs    on acs.aluno_id = cl.id
      left join port   on port.cpf = cl.cpf11
      left join contr  on contr.cpf = cl.cpf11
      left join ext    on ext.cpf = cl.cpf11
      left join ext_qq on ext_qq.cpf = cl.cpf11
      left join semret on semret.cpf = cl.cpf11
      left join fila   on fila.cpf = cl.cpf11
  ), classe as (
    select b.*,
           case when b.cpf11 is null then 'CPF INVÁLIDO'
                when b.l195 and b.l166 then 'AMBOS (195 Reativa + 166 Santander)'
                when b.l195 then 'SÓ REATIVA (195)'
                when b.l166 then 'SÓ SANTANDER (166)'
                when b.conhece then 'NENHUM (Prime conhece o CPF, fora dos 2 portadores)'
                when b.nao_devolve then 'NENHUM (Prime não devolve o CPF)'
                else 'NENHUM (ainda não consultado no Prime)' end as portador_prime,
           case when b.cpf11 is null then 'CPF INVÁLIDO'
                when not b.conhece then 'SEM DADO NO PRIME'
                when coalesce(b.abertos_n, 0) > 0 then 'SIM'
                when b.tem_extrato then 'NÃO'
                when b.l195 then 'SEM EXTRATO (na lista 195, extrato não coletado)'
                else 'NÃO' end as pendencia_reativa,
           case when b.cpf11 is null then 'CPF INVÁLIDO'
                when not b.conhece then 'SEM DADO NO PRIME'
                when not b.l166 then 'NÃO (fora do 166)'
                when b.ativos > 0 and b.saldo_ativo > 0 then 'SIM (acordo ativo no CRM com saldo)'
                when b.ativos > 0 then 'SIM (acordo ativo no CRM)'
                when b.quitados > 0 then 'PROVÁVEL NÃO (166, acordo quitado no CRM)'
                when b.cancelados > 0 then 'INDETERMINADO (166, acordo cancelado no CRM)'
                else 'INDETERMINADO (166 sem acordo no CRM)' end as pendencia_santander
      from base b
  )
  select c.aluno_id, c.nome, c.cpf_mascarado, c.matricula_crm, c.matricula_prime, c.unidade, c.curso, c.operador,
         c.caso_codigo, c.n_casos, c.situacao_crm, c.saldo_crm,
         c.mens_n, c.mens_valor,
         c.ativos, c.saldo_ativo, c.quitados, c.cancelados,
         c.l195, c.l166, c.conhece, c.nao_devolve,
         c.coletado_em, c.p195_titulos, c.abertos_n, c.abertos_valor,
         c.abertos_venc_min, c.abertos_venc_max, c.abertos_fora_crm_n, c.abertos_fora_crm_valor,
         c.liquidados_n, c.ultima_liq,
         c.crm_abertos_liq_n, c.crm_abertos_liq_valor,
         c.st_2026_2, c.curso_2026_2, c.campus_2026_2,
         c.portador_prime, c.pendencia_reativa, c.pendencia_santander,
         case when c.cpf11 is null then 'CPF INVÁLIDO'
              when not c.conhece then 'SEM DADO NO PRIME'
              when c.pendencia_reativa = 'SIM' and c.pendencia_santander like 'SIM%' then 'AMBOS'
              when c.pendencia_reativa = 'SIM' then 'SÓ REATIVA'
              when c.pendencia_santander like 'SIM%' then 'SÓ SANTANDER'
              when c.pendencia_reativa like 'SEM EXTRATO%' or c.pendencia_santander like 'INDETERMINADO%' then 'INDETERMINADO'
              else 'NENHUM' end as resumo,
         now()
    from classe c;

  select jsonb_build_object(
           'alunos', count(*),
           'calculado_em', max(calculado_em),
           'por_resumo', (select jsonb_object_agg(resumo, n) from (select resumo, count(*) n from public.revisao_prime_aluno group by resumo) r),
           'por_portador', (select jsonb_object_agg(portador_prime, n) from (select portador_prime, count(*) n from public.revisao_prime_aluno group by portador_prime) p))
    into v_out
    from public.revisao_prime_aluno;

  return v_out;
end;
$function$;

revoke all on function public.revisao_prime_recalcular() from public, anon;
grant execute on function public.revisao_prime_recalcular() to authenticated, service_role;

comment on function public.revisao_prime_recalcular() is
  'Recalcula o retrato revisao_prime_aluno (100% dos casos do CRM x Prime). Só gestão ou service_role.';
