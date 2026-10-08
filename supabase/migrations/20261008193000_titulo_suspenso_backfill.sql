-- BACKFILL DO SUSPENSO: as mensalidades de quem JA esta com cobranca suspensa.
--
-- Depende de 20261008192000 e tem de rodar DEPOIS dela.
--
-- Dado HISTORICO, universo CONGELADO, trava EXATA -- ao contrario do reparo da
-- 20261008191000, que e por regra porque o universo cresce enquanto a gestao
-- tabula. Aqui sao 187 titulos ABERTO que estao assim desde antes da regra
-- existir, e a contagem exata e a protecao certa: se o banco divergir da
-- medicao, a transacao volta inteira e alguem remede antes de escrever.
--
-- O UNIVERSO, medido em 08/10/2026 19:05 UTC:
--
--   187 titulos ABERTO .......... R$ 462.784,01
--    59 titulos EM_CONFIRMACAO .. R$  78.129,09   <- os que a gestao disse que
--                                                    NUNCA podem ficar "em
--                                                    confirmacao de pagamento"
--   ---------------------------------------------
--   246 titulos ................. R$ 540.913,10
--
-- O QUE FICA DE FORA, e por que:
--   *  7 titulos PAGO de aluno suspenso -- pagamento real vence sempre;
--   * 17 DUPLICADA e 8 CANCELADA -- ja estao fora do saldo por outra causa, e
--     marca-los SUSPENSO misturaria duas causas no mesmo campo;
--   * titulo com vinculo a acordo vivo -- a divida dele mora nas PARCELAS do
--     acordo, que o motor suspende por outro caminho. Marcar o titulo tambem
--     contaria a mesma divida duas vezes.
--
-- CONSEQUENCIA JA ACEITA PELA GESTAO (ver 20261008192000): os R$ 462.784,01
-- saem tambem do saldo REGISTRADO e de `saude_carteira_panorama`.
--
-- POR QUE PASSA PELO MOTOR e nao por UPDATE a mao: `parcela_efeito_sem_pagamento_aplicar`
-- ja guarda o estado anterior em `suspensao_*` (sem isso a reativacao nao
-- saberia para onde voltar), ja usa a chave da Conferencia Prime no escopo
-- estreito necessario para tirar os 59 de EM_CONFIRMACAO, e ja PROVA que
-- gravou. Reescrever isso aqui seria uma segunda implementacao da mesma regra.
--
-- PITR NAO esta habilitado: o backup linha a linha em jsonb E o caminho de
-- reversao.
--
-- ROLLBACK: supabase/rollbacks/20261008193000_titulo_suspenso_backfill.rollback.sql

-- A TABELA DE BACKUP, garantida aqui. Mesmo motivo da 20261008191000:
-- depender do efeito colateral de outra migration e fragil, e uma migration que
-- GRAVA backup tem de garantir o proprio destino. Idempotente.
create table if not exists public._backup_backfill_efeito_sem_pagamento (
  id uuid primary key default gen_random_uuid(),
  lote text not null,
  tabela text not null,
  registro_id uuid not null,
  aluno_id uuid,
  snapshot jsonb not null,
  criado_em timestamptz not null default now()
);
alter table public._backup_backfill_efeito_sem_pagamento enable row level security;
drop policy if exists _backup_backfill_efeito_deny on public._backup_backfill_efeito_sem_pagamento;
create policy _backup_backfill_efeito_deny
  on public._backup_backfill_efeito_sem_pagamento for all to authenticated, anon
  using (false) with check (false);
create index if not exists idx_backup_backfill_efeito_lote
  on public._backup_backfill_efeito_sem_pagamento(lote, tabela);

do $backfill$
declare
  c_lote text := 'suspenso_titulo_20261008193000';
  c_esp_qtd int := coalesce(nullif(current_setting('backfill.esperado_suspenso_qtd', true),'')::int, 246);
  c_esp_val numeric := coalesce(nullif(current_setting('backfill.esperado_suspenso_valor', true),'')::numeric, 540913.10);
  v_qtd int; v_val numeric; v_alunos int; v_ja int;
  v_r jsonb; v_aluno record;
  v_tit_total int := 0; v_val_total numeric := 0;
  v_pagos_antes int; v_pagos_depois int;
  v_honor_antes numeric; v_honor_depois numeric;
begin
  select count(*) into v_ja
    from public._backup_backfill_efeito_sem_pagamento where lote = c_lote;
  if v_ja > 0 then
    raise notice 'suspenso: lote % ja aplicado (% linhas). Nada a fazer.', c_lote, v_ja;
    return;
  end if;

  -- ---- alvo: aluno com cobranca suspensa + titulo ainda contabilizando -----
  create temporary table _sp_alvo on commit drop as
  select al.id as aluno_id
    from public.alunos al
   where coalesce(nullif(al.status_jornada,''), al.status_atual) = 'SUSPENSAO_COBRANCA';

  create temporary table _sp_titulos on commit drop as
  select t.id, t.aluno_id, t.situacao as situacao_antes, t.status as status_antes,
         coalesce(t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0) as valor
    from _sp_alvo b join public.acordos_titulos t on t.aluno_id = b.aluno_id
   where upper(coalesce(t.situacao,'')) in ('ABERTO','NEGOCIADO','EM_CONFIRMACAO')
     and coalesce(lower(t.status),'') <> 'quitada'
     and t.origem_encerramento is null
     and not exists (
       select 1 from public.acordo_titulo_vinculo v
         join public.acordos a on a.id = v.acordo_id
        where v.titulo_id = t.id and coalesce(v.ativo, true)
          and upper(coalesce(a.status,'')) not in ('CANCELADO','CANCELADA'));

  select count(*), round(coalesce(sum(valor),0),2), count(distinct aluno_id)
    into v_qtd, v_val, v_alunos from _sp_titulos;

  if v_qtd <> c_esp_qtd or v_val <> c_esp_val then
    raise exception 'suspenso: universo divergiu da medicao. Esperado % / R$ %, obtive % / R$ %. Remedir antes de aplicar.',
      c_esp_qtd, c_esp_val, v_qtd, v_val;
  end if;

  -- ---- nada com marca de pagamento pode entrar ----------------------------
  if exists (select 1 from _sp_titulos s join public.acordos_titulos t on t.id = s.id
              where t.origem_liquidacao is not null) then
    raise exception 'suspenso: ha titulo com origem_liquidacao no alvo. Abortado sem escrever.';
  end if;
  if exists (select 1 from _sp_titulos s
              where upper(coalesce(s.situacao_antes,'')) = 'PAGO'
                 or lower(coalesce(s.status_antes,'')) = 'quitada') then
    raise exception 'suspenso: titulo PAGO entrou no alvo. Pagamento real nao se suspende. Abortado.';
  end if;

  -- fotografia do dinheiro, para conferir depois que nada se moveu
  select count(*) into v_pagos_antes from public.pagamentos;
  select coalesce(sum(honorarios),0) into v_honor_antes from public.parcelas;

  -- ---- snapshot de quitacao ANTES, na mesma transacao ---------------------
  create temporary table _sp_quitado_antes on commit drop as
  select c.id, c.quitado_em, c.origem_quitacao
    from public.casos c
   where c.aluno_id in (select aluno_id from _sp_alvo);

  -- ---- BACKUP -------------------------------------------------------------
  insert into public._backup_backfill_efeito_sem_pagamento (lote, tabela, registro_id, aluno_id, snapshot)
  select c_lote, 'acordos_titulos', t.id, t.aluno_id, to_jsonb(t.*)
    from _sp_titulos s join public.acordos_titulos t on t.id = s.id;

  insert into public._backup_backfill_efeito_sem_pagamento (lote, tabela, registro_id, aluno_id, snapshot)
  select c_lote, 'parcelas', p.id, b.aluno_id, to_jsonb(p.*)
    from _sp_alvo b
    join public.acordos a on a.aluno_id = b.aluno_id
    join public.parcelas p on p.acordo_id = a.id
   where public.parcela_viva(p.status);

  -- ---- APLICA PELO MOTOR, aluno por aluno ---------------------------------
  for v_aluno in select aluno_id from _sp_alvo
                  where aluno_id in (select aluno_id from _sp_titulos) loop
    v_r := public.parcela_efeito_sem_pagamento_aplicar(
      v_aluno.aluno_id,
      'backfill de 08/10/2026 autorizado pela gestao: a cobranca ja estava suspensa antes de a regra marcar a mensalidade',
      'SUSPENSAO_COBRANCA',
      false);
    v_tit_total := v_tit_total + coalesce((v_r->>'titulos_encerrados_qtd')::int, 0);
    v_val_total := v_val_total + coalesce((v_r->>'titulos_encerrados_valor')::numeric, 0);
  end loop;

  -- ---- CONFERENCIA DEPOIS -------------------------------------------------
  if v_tit_total <> v_qtd then
    raise exception 'suspenso: o motor marcou % titulos, o alvo tinha %. Abortado.', v_tit_total, v_qtd;
  end if;

  if exists (select 1 from _sp_titulos s join public.acordos_titulos t on t.id = s.id
              where upper(coalesce(t.situacao,'')) <> 'SUSPENSO'
                 or lower(coalesce(t.status,'')) <> 'suspenso') then
    raise exception 'suspenso: algum titulo nao ficou SUSPENSO -- gatilho reverteu em silencio. Abortado.';
  end if;

  -- A REVERSIBILIDADE E PARTE DO CONTRATO, nao um detalhe: sem o estado
  -- anterior gravado, levantar a suspensao deixaria a mensalidade presa.
  if exists (select 1 from _sp_titulos s join public.acordos_titulos t on t.id = s.id
              where t.suspensao_situacao_anterior is null
                 or t.suspensao_origem is null) then
    raise exception 'suspenso: algum titulo ficou SUSPENSO sem o estado anterior gravado. A suspensao seria irreversivel. Abortado.';
  end if;

  -- os 59 que estavam em confirmacao tem de ter saido de la, e poder voltar
  if exists (select 1 from _sp_titulos s join public.acordos_titulos t on t.id = s.id
              where upper(coalesce(s.situacao_antes,'')) = 'EM_CONFIRMACAO'
                and upper(coalesce(t.suspensao_situacao_anterior,'')) <> 'EM_CONFIRMACAO') then
    raise exception 'suspenso: titulo que estava EM_CONFIRMACAO nao guardou esse estado. A reativacao o devolveria para a fila errada. Abortado.';
  end if;

  -- NENHUM encerramento: suspensao nao encerra
  if exists (select 1 from _sp_titulos s join public.acordos_titulos t on t.id = s.id
              where t.origem_encerramento is not null) then
    raise exception 'suspenso: algum titulo recebeu origem_encerramento. Suspensao nao encerra. Abortado.';
  end if;

  -- NENHUMA quitacao nova nem alterada
  if exists (
    select 1 from public.casos c join _sp_quitado_antes z on z.id = c.id
     where c.quitado_em is distinct from z.quitado_em
        or coalesce(c.origem_quitacao,'') is distinct from coalesce(z.origem_quitacao,'')) then
    raise exception 'suspenso: algum caso teve quitado_em/origem_quitacao ALTERADO. Abortado.';
  end if;

  -- NENHUM dinheiro se moveu
  select count(*) into v_pagos_depois from public.pagamentos;
  select coalesce(sum(honorarios),0) into v_honor_depois from public.parcelas;
  if v_pagos_depois <> v_pagos_antes or v_honor_depois <> v_honor_antes then
    raise exception 'suspenso: pagamentos (% -> %) ou honorarios (% -> %) mudaram. Abortado.',
      v_pagos_antes, v_pagos_depois, v_honor_antes, v_honor_depois;
  end if;

  raise notice 'suspenso OK -- % aluno(s), % mensalidade(s) SUSPENSO (R$ %); backup no lote %. Zero encerramento, zero quitacao, dinheiro intocado.',
    v_alunos, v_tit_total, round(v_val_total,2), c_lote;
end
$backfill$;
