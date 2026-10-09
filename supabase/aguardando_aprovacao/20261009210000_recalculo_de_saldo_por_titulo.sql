-- NAO APLICAR sem autorizacao expressa da Amanda.
--
-- CORRECAO ESTRUTURAL: aluno SEM CASO nunca teve o saldo recalculado.
--
-- O DEFEITO, medido em producao em 09/10/2026
-- ------------------------------------------
-- 485 alunos tem titulo cobravel em aberto e `alunos.saldo_total` NULO --
-- R$ 692.047,04 de divida que existe em `acordos_titulos` e nao aparece no
-- campo que a carteira, as filas e os indicadores leem. Outros 22 estao com
-- saldo ZERO carregando R$ 70.179,08. Treze desses 485 sao os alunos do
-- bordero 723 (R$ 79.856,84) que motivaram esta frente.
--
-- A CAUSA, em duas metades da mesma coisa: NADA recalcula o saldo de um aluno
-- que nao tem caso.
--
--   1. `acordos_titulos` NAO tem gatilho de recalculo. Todas as outras tabelas
--      financeiras tem: `acordos` (trg_recalc_acordo), `parcelas`
--      (trg_recalc_parcela), `baixas_pagamento` (trg_recalc_baixa),
--      `solicitacoes_confirmacao_pagamento` (trg_recalc_conf), `termos_acordo`
--      (trg_recalc_termo_ins/upd), `acordo_titulo_vinculo`
--      (trg_recalc_vinculo_ins/upd). O bordero grava mensalidade em
--      `acordos_titulos` -- e so ali --, entao nenhum gatilho dispara.
--
--   2. `recalcular_situacao_virada_diaria` varre `from public.casos c`. Quem
--      nao tem caso nao esta na varredura, e por isso a virada do dia seguinte
--      tambem nao corrige. (Um dos 14 CPFs do bordero tem saldo calculado:
--      foi trabalhada e algum outro evento disparou o recalculo. Os outros 13
--      ficaram como estavam.)
--
-- `recalcular_situacao_aluno` JA SABE somar titulo -- o bloco `v_tit_val` le
-- `acordos_titulos` pela regra canonica (ABERTO/NEGOCIADO, status <> quitada,
-- tipo_boleto <> 'Acordo', sem vinculo a acordo vivo, nao superado por acordo).
-- Nao ha regra nova aqui: o que falta e CHAMAR a funcao.
--
-- POR QUE UMA FILA, E NAO O RECALCULO DIRETO NO GATILHO
-- ----------------------------------------------------
-- `recalcular_situacao_aluno` faz varias consultas por aluno. Um bordero tem
-- 2.155 linhas (723) e grava em lotes de 500: recalcular dentro do gatilho
-- seria ate 500 execucoes da funcao dentro de UMA instrucao, com risco real de
-- estourar o tempo da requisicao do navegador e derrubar uma importacao
-- financeira pela metade. Entao o gatilho e de INSTRUCAO (nao de linha), usa
-- tabela de transicao e faz UMA escrita barata: enfileira os aluno_id
-- distintos. O recalculo acontece depois, em lote controlado, por
-- `recalculo_saldo_pendente_processar`.
--
-- A fila e duravel: se o processamento nao rodar, o pendente fica registrado e
-- e processado na proxima chamada. Nada se perde em silencio.
--
-- NAO TOCA EM DIVIDA. Nem esta migration nem a funcao de recalculo escrevem em
-- `acordos_titulos`, `acordos`, `parcelas`, `pagamentos`, `baixas_pagamento`,
-- `aluno_movimentacoes` ou `solicitacoes_*`. `recalcular_situacao_aluno`
-- escreve em `casos` e `alunos`: criticidade, situacao_operacional,
-- proxima_acao, saldo_vencido, saldo_total, data_retorno, retorno_origem.
-- Responsavel, titulo, pagamento e historico ficam intactos.

-- ---------------------------------------------------------------------------
-- 1. A fila
-- ---------------------------------------------------------------------------
create table if not exists public.recalculo_saldo_pendente (
  aluno_id       uuid primary key,
  enfileirado_em timestamptz not null default now(),
  origem         text
);

alter table public.recalculo_saldo_pendente enable row level security;
alter table public.recalculo_saldo_pendente force row level security;
revoke all on public.recalculo_saldo_pendente from anon, authenticated;

comment on table public.recalculo_saldo_pendente is
  'Alunos com titulo alterado cujo saldo ainda nao foi recalculado. Gravada por gatilho de instrucao em acordos_titulos, drenada por recalculo_saldo_pendente_processar. RLS deny-all: so service_role/gestao, via RPC.';

-- ---------------------------------------------------------------------------
-- 2. O gatilho: de INSTRUCAO, uma escrita por lote
-- ---------------------------------------------------------------------------
create or replace function public._trg_enfileirar_recalculo_titulo()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
begin
  -- Nunca derruba a escrita do titulo: a divida gravar e mais importante que o
  -- campo derivado ficar atualizado no mesmo instante. Se isto falhar, a fila
  -- nao recebe a linha e a divida continua correta em acordos_titulos.
  begin
    if TG_OP in ('INSERT','UPDATE') then
      insert into public.recalculo_saldo_pendente (aluno_id, origem)
      select distinct n.aluno_id::uuid, 'trg_titulo_'||lower(TG_OP)
        from novo n where n.aluno_id is not null
      on conflict (aluno_id) do nothing;
    end if;

    if TG_OP in ('UPDATE','DELETE') then
      insert into public.recalculo_saldo_pendente (aluno_id, origem)
      select distinct v.aluno_id::uuid, 'trg_titulo_'||lower(TG_OP)
        from velho v where v.aluno_id is not null
      on conflict (aluno_id) do nothing;
    end if;
  exception when others then null;
  end;
  return null;
end;
$function$;

revoke all on function public._trg_enfileirar_recalculo_titulo() from public, anon, authenticated;

drop trigger if exists trg_enfileirar_recalculo_titulo_ins on public.acordos_titulos;
create trigger trg_enfileirar_recalculo_titulo_ins
  after insert on public.acordos_titulos
  referencing new table as novo
  for each statement execute function public._trg_enfileirar_recalculo_titulo();

drop trigger if exists trg_enfileirar_recalculo_titulo_upd on public.acordos_titulos;
create trigger trg_enfileirar_recalculo_titulo_upd
  after update on public.acordos_titulos
  referencing new table as novo old table as velho
  for each statement execute function public._trg_enfileirar_recalculo_titulo();

drop trigger if exists trg_enfileirar_recalculo_titulo_del on public.acordos_titulos;
create trigger trg_enfileirar_recalculo_titulo_del
  after delete on public.acordos_titulos
  referencing old table as velho
  for each statement execute function public._trg_enfileirar_recalculo_titulo();

-- ---------------------------------------------------------------------------
-- 3. O dreno
-- ---------------------------------------------------------------------------
create or replace function public.recalculo_saldo_pendente_processar(
  p_limite int default 500,
  p_lote text default null
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
set statement_timeout to '240s'
as $function$
declare
  r record;
  v_ok int := 0;
  v_erro int := 0;
  v_lote text := coalesce(p_lote, 'recalc_'||to_char(now(),'YYYYMMDDHH24MISS'));
begin
  if coalesce(auth.role(),'') <> 'service_role'
     and not coalesce(public.usuario_e_gestao(), false) then
    raise exception 'Acesso negado: recalcular saldo e restrito a gestao.' using errcode = '42501';
  end if;

  if p_limite is null or p_limite < 1 or p_limite > 5000 then
    raise exception 'Limite fora da faixa (1..5000): %', p_limite using errcode = '22023';
  end if;

  for r in
    select aluno_id from public.recalculo_saldo_pendente
     order by enfileirado_em asc
     limit p_limite
  loop
    begin
      -- a funcao canonica, sem regra nova nenhuma
      perform public.recalcular_situacao_aluno(r.aluno_id, v_lote);
      delete from public.recalculo_saldo_pendente where aluno_id = r.aluno_id;
      v_ok := v_ok + 1;
    exception when others then
      -- a linha FICA na fila para a proxima passada
      v_erro := v_erro + 1;
    end;
  end loop;

  return jsonb_build_object(
    'lote', v_lote,
    'processados', v_ok,
    'com_erro', v_erro,
    'restantes', (select count(*) from public.recalculo_saldo_pendente));
end;
$function$;

revoke all on function public.recalculo_saldo_pendente_processar(int, text) from public, anon;
grant execute on function public.recalculo_saldo_pendente_processar(int, text) to authenticated;

comment on function public.recalculo_saldo_pendente_processar(int, text) is
  'Drena recalculo_saldo_pendente chamando recalcular_situacao_aluno. So gestao/service_role. Idempotente: a linha sai da fila quando o recalculo passa, e fica quando falha.';
