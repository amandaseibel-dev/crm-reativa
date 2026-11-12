-- ============================================================================
-- GIRO x FIDELIZAÇÃO · PASSO 0 · BACKUP POR ID (12/11/2026)
-- ----------------------------------------------------------------------------
-- NÃO EXECUTAR sem autorização expressa. Validado só em PGlite
-- (supabase/tests/fidelizacao_giro_lotes.test.js).
--
-- O QUE FAZ: cria `_backup_fidelizacao_giro_20261112`, define QUEM entra em
-- cada lote e guarda o estado de cada caso. Distribui em 3 lotes FIXOS:
--   lote 1 = cobranca13  |  lote 2 = cobranca06  |  lote 3 = todos os demais
-- O universo é o que a regra nova solta: `casos_elegiveis_liberacao_fidelizacao()`
-- menos giro ainda vigente e menos retorno marcado pelo operador (hoje/futuro).
-- Não escreve em casos, alunos ou histórico.
--
-- O estado gravado aqui serve para a CONFERÊNCIA do universo. O estado usado
-- na restauração é regravado pelo passo 1 no instante de cada liberação (o
-- intervalo entre lotes pode ser de dias).
--
-- A UNIDADE É O ALUNO, NÃO O CASO. Medido em produção em 12/11/2026: soltar um
-- caso solta, por gatilho (`trg_sync_casos_resp_aluno`), TODOS os casos do
-- mesmo aluno. Por isso cada linha tem um `tipo`:
--   ALVO     caso elegível: é ele que a liberação solta;
--   ARRASTO  outro caso do MESMO aluno e MESMO operador que pode sair junto:
--            já encerrado, fora dos 10 dias, sem giro vigente, NÃO congelado e
--            NÃO protegido. Sai por gatilho; fica registrado para poder voltar;
--   RETIDO   caso elegível cujo aluno fica FORA dos lotes, porque (a) tem outro
--            caso que não pode sair, ou (b) o responsável gravado no aluno não
--            é o operador do caso (a cascata do gatilho não funcionaria).
--
-- TRAVAS (cada uma aborta sem criar nada):
--   * a migration 20261112210000 tem de estar aplicada;
--   * o cron `fidelizacao_liberar_vencidos` tem de estar PAUSADO e o de
--     reposição de carteira não pode estar ativo;
--   * a data do banco (UTC) tem de ser a mesma de São Paulo: entre 21h e 24h
--     BRT o banco já está no dia seguinte e o 10º dia contaria como 11º;
--   * a tabela não pode existir (não sobrescreve backup).
--
-- DADO PESSOAL: sem CPF, nome, telefone ou e-mail de aluno. Guarda `aluno_id`,
-- saldo e status -- dado pseudonimizado. RLS ligada e `revoke all` de
-- PUBLIC/anon/authenticated (tabela nova herda TRUNCATE para `authenticated` e
-- a RLS não cobre TRUNCATE). DESCARTE: apagar a tabela 30 dias depois do último
-- lote, com autorização.
-- ============================================================================
begin;
set local statement_timeout = '120s';

do $guarda$
declare v_n int;
begin
  if current_date <> (now() at time zone 'America/Sao_Paulo')::date then
    raise exception 'backup_giro: a data do banco (%) nao e a de Sao Paulo (%). Rode antes das 21h ou depois da meia-noite (BRT).',
      current_date, (now() at time zone 'America/Sao_Paulo')::date;
  end if;
  if position('caso_em_giro_fidelizacao' in
       pg_get_functiondef('public.liberar_fidelizacao_caso(uuid,text,text)'::regprocedure)) = 0 then
    raise exception 'backup_giro: a migration 20261112210000 NAO esta aplicada.';
  end if;
  if to_regclass('cron.job') is null then
    raise exception 'backup_giro: cron.job nao existe; nao da para conferir que o cron esta pausado.';
  end if;
  execute $q$select count(*) from cron.job where jobname = 'fidelizacao_liberar_vencidos' and not active$q$ into v_n;
  if v_n <> 1 then
    raise exception 'backup_giro: o cron fidelizacao_liberar_vencidos esta ATIVO ou ausente; pause antes.';
  end if;
  execute $q$select count(*) from cron.job where jobname = 'reposicao_carteira_minuto'$q$ into v_n;
  if v_n <> 1 then
    raise exception 'backup_giro: o job reposicao_carteira_minuto nao foi encontrado pelo nome; nao da para garantir que esta pausado.';
  end if;
  execute $q$select count(*) from cron.job where jobname = 'reposicao_carteira_minuto' and active$q$ into v_n;
  if v_n > 0 then
    raise exception 'backup_giro: o cron de reposicao de carteira esta ATIVO; ele redistribuiria os casos soltos.';
  end if;
  if to_regclass('public._backup_fidelizacao_giro_20261112') is not null then
    raise exception 'backup_giro: _backup_fidelizacao_giro_20261112 ja existe; nao sobrescrevo backup.';
  end if;
end
$guarda$;

create table public._backup_fidelizacao_giro_20261112 (
  caso_id                     uuid primary key,
  aluno_id                    uuid,
  unidade                     uuid not null,   -- aluno_id; ou o proprio caso, se nao houver aluno
  tipo                        text not null check (tipo in ('ALVO', 'ARRASTO', 'RETIDO')),
  lote                        smallint not null check (lote in (1, 2, 3)),
  -- CASO
  operador_email              text not null,
  operador_nome               text,
  operador                    text,
  caso_status_atual           text,
  caso_status_acionamento     text,
  caso_status_financeiro      text,
  caso_data_ultimo_acionamento date,
  caso_giro_fidelizacao_ate   date,
  -- ALUNO (o que a cadeia de gatilhos zera ou reescreve na troca de dono)
  resp_email                  text,
  resp_nome                   text,
  resp_em                     timestamptz,
  aluno_status_atual          text,
  aluno_status_jornada        text,
  aluno_status_acionamento    text,
  aluno_data_ultimo_acionamento timestamptz,
  aluno_proxima_acao          text,
  aluno_data_retorno          date,
  aluno_hora_retorno          text,
  aluno_retorno_origem        text,
  aluno_retorno_confirmado_em timestamptz,
  aluno_nivel_criticidade     text,
  saldo_aberto                numeric,
  -- CONTROLE
  criado_em                   timestamptz not null default now(),
  retrato_em                  timestamptz not null default now(),  -- regravado no instante da liberacao
  liberado_em                 timestamptz,
  liberado_por                text,
  pulado_motivo               text,
  restaurado_em               timestamptz,
  restaurado_motivo           text
);

alter table public._backup_fidelizacao_giro_20261112 enable row level security;
revoke all on table public._backup_fidelizacao_giro_20261112 from public, anon, authenticated;

comment on table public._backup_fidelizacao_giro_20261112 is
  'Liberacao da fidelizacao do giro (12/11/2026): universo por aluno, lote fixo 1/2/3 e estado anterior de cada caso. Sem CPF/nome/telefone. Base da restauracao por id. Descartar 30 dias apos o ultimo lote.';

with elig as (
  select c.id as caso_id, c.aluno_id, coalesce(c.aluno_id, c.id) as unidade, lower(c.operador_email) as op
    from public.casos_elegiveis_liberacao_fidelizacao() e
    join public.casos c on c.id = e.caso_id
   where not public.caso_em_giro_fidelizacao(c.giro_fidelizacao_ate)
     and not exists (
           select 1 from public.alunos r
            where r.id = c.aluno_id
              and r.data_retorno >= (now() at time zone 'America/Sao_Paulo')::date
              and upper(coalesce(r.retorno_origem, '')) like 'OPERADOR%')
),
dono as (  -- o operador da unidade; mais de um = unidade fora da regra
  select unidade, min(op) as op, count(distinct op) as n_op from elig group by unidade
),
todos as (  -- TODOS os casos de cada unidade, elegiveis ou nao
  select c.id as caso_id, coalesce(c.aluno_id, c.id) as unidade
    from public.casos c
   where c.id in (select caso_id from elig)
      or c.aluno_id in (select aluno_id from elig where aluno_id is not null)
),
classe as (
  select t.caso_id, t.unidade,
         case
           when t.caso_id in (select caso_id from elig) then 'ALVO'
           when lower(c.operador_email) = d.op
                and (coalesce(c.encerrado_operacional, false)
                     or public.caso_encerrado_operacional(c.cpf_limpo, c.status_atual, c.status_acionamento,
                                                          c.status_financeiro, c.status_jornada))
                -- encerrado NAO basta para sair por arrasto:
                and not public.caso_dentro_prazo_fidelizacao(c.data_ultimo_acionamento)
                and not public.caso_em_giro_fidelizacao(c.giro_fidelizacao_ate)
                and not public.caso_encerramento_congelado(c.id)
                and not public.caso_protegido_redistribuicao(c.cpf_limpo, c.status_acionamento, c.nao_acionar,
                          c.status_financeiro, c.valor_pago, c.quitado_em, c.valor_quitado)
             then 'ARRASTO'
           else 'FORA'
         end as classe
    from todos t
    join public.casos c on c.id = t.caso_id
    join dono d on d.unidade = t.unidade
),
unidade_motivo as (
  select k.unidade,
         case
           when bool_or(k.classe = 'FORA') or max(d.n_op) <> 1 then 'aluno_com_outro_caso_fora_da_regra'
           when exists (select 1 from public.alunos a
                         where a.id = k.unidade
                           and lower(a.responsavel_atual_email) is distinct from max(d.op))
             then 'responsavel_do_aluno_diverge_do_operador_do_caso'
         end as motivo
    from classe k join dono d on d.unidade = k.unidade
   group by k.unidade
)
insert into public._backup_fidelizacao_giro_20261112 (
  caso_id, aluno_id, unidade, tipo, lote, pulado_motivo,
  operador_email, operador_nome, operador,
  caso_status_atual, caso_status_acionamento, caso_status_financeiro,
  caso_data_ultimo_acionamento, caso_giro_fidelizacao_ate,
  resp_email, resp_nome, resp_em,
  aluno_status_atual, aluno_status_jornada, aluno_status_acionamento,
  aluno_data_ultimo_acionamento, aluno_proxima_acao, aluno_data_retorno,
  aluno_hora_retorno, aluno_retorno_origem, aluno_retorno_confirmado_em,
  aluno_nivel_criticidade, saldo_aberto)
select c.id, c.aluno_id, k.unidade,
       case when u.motivo is null then k.classe else 'RETIDO' end,
       case d.op
         when 'cobranca13@aelbra.com.br' then 1
         when 'cobranca06@aelbra.com.br' then 2
         else 3 end,
       u.motivo,
       c.operador_email, c.operador_nome, c.operador,
       c.status_atual, c.status_acionamento, c.status_financeiro,
       c.data_ultimo_acionamento, c.giro_fidelizacao_ate,
       a.responsavel_atual_email, a.responsavel_atual_nome, a.responsavel_atual_em,
       a.status_atual, a.status_jornada, a.status_acionamento,
       a.data_ultimo_acionamento, a.proxima_acao, a.data_retorno,
       a.hora_retorno, a.retorno_origem, a.retorno_confirmado_em,
       a.nivel_criticidade, public.saldo_titulos_aberto(c.cpf_limpo)
  from classe k
  join unidade_motivo u on u.unidade = k.unidade
  join dono d on d.unidade = k.unidade
  join public.casos c on c.id = k.caso_id
  left join public.alunos a on a.id = c.aluno_id
 where u.motivo is null or k.classe = 'ALVO';   -- de unidade retida, registra so os elegiveis

-- Conferencia: o que entrou, por lote e operador (le o proprio backup).
select b.lote, split_part(b.operador_email, '@', 1) operador,
       count(distinct b.unidade) filter (where b.tipo <> 'RETIDO') alunos_no_lote,
       count(*) filter (where b.tipo = 'ALVO') casos_alvo,
       count(*) filter (where b.tipo = 'ARRASTO') casos_arrasto,
       count(*) filter (where b.pulado_motivo = 'aluno_com_outro_caso_fora_da_regra') retidos_outro_caso,
       count(*) filter (where b.pulado_motivo = 'responsavel_do_aluno_diverge_do_operador_do_caso') retidos_dessincronia,
       round(sum(b.saldo_aberto) filter (where b.tipo = 'ALVO')) saldo_alvo
  from public._backup_fidelizacao_giro_20261112 b
 group by rollup (b.lote, split_part(b.operador_email, '@', 1))
 order by 1 nulls last, 2 nulls last;

commit;
