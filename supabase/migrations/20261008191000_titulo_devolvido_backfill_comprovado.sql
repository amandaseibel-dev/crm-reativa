-- DOIS CONSERTOS, com exigencias de prova DIFERENTES de proposito.
--
-- Depende de 20261008190000 (titulo DEVOLVIDO) e tem de rodar DEPOIS dela.
--
-- PARTE A -- RERROTULAR OS 19 TITULOS HISTORICOS. Dado historico, universo
-- CONGELADO, trava EXATA. A gestao autorizou corrigir "apenas quando
-- comprovada a devolucao", e aqui a devolucao e comprovada por TRES variaveis
-- independentes, medidas em 08/10/2026 18:45 UTC:
--
--   1. `origem_encerramento` = 'CANCELAMENTO_COBRANCA', que e uma das cinco
--      tabulacoes com `efeito_desfecho = 'DEVOLVE_PARCELA'` no catalogo. E
--      registro de maquina do que causou o encerramento, nao inferencia;
--   2. `origem_liquidacao is null` nos 19/19 -- nenhuma marca de liquidacao;
--   3. existe linha em `parcela_efeito_sem_pagamento_auditoria` para o mesmo
--      aluno, com a MESMA origem e `efeito = 'DEVOLVIDA'`, em 19/19. Esta e a
--      variavel de outra natureza: outra tabela, escrita por outro caminho.
--
--   19 titulos, R$ 133.089,35, 16 alunos.
--
-- OS 29 DA CONFERENCIA PRIME FICAM COMO ESTAO, por instrucao expressa da
-- gestao. Eles tem `origem_encerramento = 'CONFERENCIA_PRIME_ADMINISTRATIVA'`,
-- que NAO e tabulacao de devolucao: a divida saiu porque nao era nossa, nao
-- porque foi devolvida. Sao R$ 286.319,45 que seguem CANCELADA, e a migration
-- RECUSA a transacao se algum deles mudar.
--
-- PARTE B -- OS CASOS QUE O MOTOR QUEBRADO DEIXOU PASSAR. Aqui NAO ha trava de
-- contagem exata por padrao, e isso e decisao consciente: o universo esta VIVO.
-- As 18:40 UTC eram 3 alunos / R$ 31.925,06; as 18:45, 4 alunos /
-- R$ 42.291,57 -- a gestao esta tabulando casos novos enquanto isto e escrito.
-- Uma trava de contagem fixa aqui abortaria por uma divergencia que JA ESTA
-- EXPLICADA, e o dano seria deixar aluno com mensalidade contando
-- indevidamente.
--
-- O que substitui a trava de contagem, sem afrouxar nada:
--   * o alvo e definido por REGRA, nao por lista: aluno cuja tabulacao atual
--     tem `efeito_desfecho = 'DEVOLVE_PARCELA'` e que AINDA tem titulo
--     contabilizando;
--   * a transacao e RECUSADA se qualquer titulo ou parcela do alvo tiver marca
--     de pagamento (`origem_liquidacao`, `pago_em`, `origem_baixa`,
--     `honorarios`);
--   * nada e quitado: a conferencia final exige `quitado_em`/`origem_quitacao`
--     identicos a um snapshot tirado no inicio da MESMA transacao;
--   * e a contagem PODE ser fixada por GUC quando a gestao quiser exatidao:
--     `backfill.esperado_reparo_qtd` e `backfill.esperado_reparo_valor`.
--     Sem GUC, a migration aplica a regra e REGISTRA o que fez.
--
-- O conserto da Parte B reusa `parcela_efeito_sem_pagamento_aplicar`, ja
-- corrigida pela 20261008190000 -- nao ha UPDATE de titulo escrito a mao aqui.
-- Assim o reparo passa exatamente pelas mesmas guardas e pela mesma auditoria
-- do fluxo normal, incluindo a asseguracao contra reversao silenciosa.
--
-- PITR NAO esta habilitado: o backup linha a linha em jsonb E o caminho de
-- reversao.
--
-- ROLLBACK: supabase/rollbacks/20261008191000_titulo_devolvido_backfill_comprovado.rollback.sql

-- ---------------------------------------------------------------------------
-- A TABELA DE BACKUP, garantida aqui
-- ---------------------------------------------------------------------------
-- Ela nasceu em 20261008130000, mas depender do efeito colateral de outra
-- migration e fragil: uma migration que GRAVA backup tem de garantir o proprio
-- destino. Idempotente, e com o mesmo formato e as mesmas policies da original
-- (RLS deny-all: a tabela guarda linha inteira de dado financeiro).
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

-- ---------------------------------------------------------------------------
-- PARTE A: os 19, com trava exata
-- ---------------------------------------------------------------------------
do $parte_a$
declare
  c_lote text := 'relabel_devolvido_20261008190000';
  c_esp_qtd int := coalesce(nullif(current_setting('backfill.esperado_relabel_qtd', true),'')::int, 19);
  c_esp_val numeric := coalesce(nullif(current_setting('backfill.esperado_relabel_valor', true),'')::numeric, 133089.35);
  c_esp_preservar int := coalesce(nullif(current_setting('backfill.esperado_preservar_qtd', true),'')::int, 29);
  v_qtd int; v_val numeric;
  v_preservar_antes int; v_preservar_depois int;
  v_ja int;
begin
  select count(*) into v_ja
    from public._backup_backfill_efeito_sem_pagamento where lote = c_lote;
  if v_ja > 0 then
    raise notice 'relabel: lote % ja aplicado (% linhas). Nada a fazer.', c_lote, v_ja;
    return;
  end if;

  create temporary table _rl_alvo on commit drop as
  select t.id,
         coalesce(t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0) as valor
    from public.acordos_titulos t
   where t.origem_encerramento in (
           select codigo from public.tabulacoes
            where ativa and efeito_desfecho = 'DEVOLVE_PARCELA')
     and upper(coalesce(t.situacao,'')) = 'CANCELADA'
     -- PROVA 2: nenhuma marca de liquidacao
     and t.origem_liquidacao is null
     -- PROVA 3: variavel independente, de outra tabela
     and exists (select 1 from public.parcela_efeito_sem_pagamento_auditoria x
                  where x.aluno_id = t.aluno_id
                    and x.origem = t.origem_encerramento
                    and x.efeito = 'DEVOLVIDA');

  select count(*), round(coalesce(sum(valor),0),2) into v_qtd, v_val from _rl_alvo;

  if v_qtd <> c_esp_qtd or v_val <> c_esp_val then
    raise exception 'relabel: universo divergiu da medicao. Esperado % / R$ %, obtive % / R$ %. Remedir antes de aplicar.',
      c_esp_qtd, c_esp_val, v_qtd, v_val;
  end if;

  select count(*) into v_preservar_antes
    from public.acordos_titulos
   where origem_encerramento = 'CONFERENCIA_PRIME_ADMINISTRATIVA';
  if v_preservar_antes <> c_esp_preservar then
    raise exception 'relabel: a Conferencia Prime tem % titulos, esperava %. Remedir antes de aplicar.',
      v_preservar_antes, c_esp_preservar;
  end if;

  insert into public._backup_backfill_efeito_sem_pagamento (lote, tabela, registro_id, aluno_id, snapshot)
  select c_lote, 'acordos_titulos', t.id, t.aluno_id, to_jsonb(t.*)
    from _rl_alvo a join public.acordos_titulos t on t.id = a.id;

  -- A CHAVE E NECESSARIA: estes titulos JA tem `origem_encerramento`, entao
  -- `_titulo_encerrado_administrativo_protegido` engata e, sem ela, restauraria
  -- `old` -- o relabel nao aconteceria e ninguem seria avisado.
  perform set_config('conferencia_prime.decisao', 'on', true);

  update public.acordos_titulos t
     set situacao = 'DEVOLVIDO',
         status   = 'devolvido',
         motivo_ajuste = coalesce(t.motivo_ajuste,'')
           || case when coalesce(t.motivo_ajuste,'') = '' then '' else ' | ' end
           || 'rotulo corrigido de CANCELADA para DEVOLVIDO em 08/10/2026: devolucao comprovada por '
           || 'origem_encerramento (' || t.origem_encerramento || '), ausencia de liquidacao e '
           || 'auditoria do motor. Nao e cancelamento administrativo e nao e recuperacao.',
         atualizado_em = now()
    from _rl_alvo a
   where t.id = a.id;

  perform set_config('conferencia_prime.decisao', '', true);

  if exists (select 1 from _rl_alvo a join public.acordos_titulos t on t.id = a.id
              where upper(coalesce(t.situacao,'')) <> 'DEVOLVIDO'
                 or lower(coalesce(t.status,'')) <> 'devolvido') then
    raise exception 'relabel: algum titulo nao ficou DEVOLVIDO -- gatilho reverteu em silencio. Abortado.';
  end if;

  select count(*) into v_preservar_depois
    from public.acordos_titulos
   where origem_encerramento = 'CONFERENCIA_PRIME_ADMINISTRATIVA'
     and upper(coalesce(situacao,'')) = 'CANCELADA';
  if v_preservar_depois <> c_esp_preservar then
    raise exception 'relabel: os % titulos da Conferencia Prime viraram %. Eles NAO podiam ser tocados. Abortado.',
      c_esp_preservar, v_preservar_depois;
  end if;

  if exists (select 1 from _rl_alvo a join public.acordos_titulos t on t.id = a.id
              where t.origem_liquidacao is not null) then
    raise exception 'relabel: titulo ganhou origem_liquidacao. Abortado.';
  end if;

  raise notice 'relabel OK -- % titulos CANCELADA->DEVOLVIDO (R$ %); % da Conferencia Prime preservados; backup no lote %.',
    v_qtd, v_val, v_preservar_depois, c_lote;
end
$parte_a$;

-- ---------------------------------------------------------------------------
-- PARTE B: reparar quem o motor quebrado deixou passar
-- ---------------------------------------------------------------------------
do $parte_b$
declare
  c_lote text := 'reparo_devolvido_20261008190000';
  c_esp_qtd int := nullif(current_setting('backfill.esperado_reparo_qtd', true),'')::int;
  c_esp_val numeric := nullif(current_setting('backfill.esperado_reparo_valor', true),'')::numeric;
  v_qtd int; v_val numeric; v_alunos int; v_ja int;
  v_r jsonb; v_aluno record;
  v_tit_total int := 0; v_val_total numeric := 0;
begin
  select count(*) into v_ja
    from public._backup_backfill_efeito_sem_pagamento where lote = c_lote;
  if v_ja > 0 then
    raise notice 'reparo: lote % ja aplicado (% linhas). Nada a fazer.', c_lote, v_ja;
    return;
  end if;

  -- ALVO POR REGRA: tabulacao definitiva + titulo ainda contabilizando
  create temporary table _rp_alvo on commit drop as
  select al.id as aluno_id,
         coalesce(nullif(al.status_jornada,''), al.status_atual) as origem
    from public.alunos al
   where coalesce(nullif(al.status_jornada,''), al.status_atual) in (
           select codigo from public.tabulacoes
            where ativa and efeito_desfecho = 'DEVOLVE_PARCELA')
     and exists (
       select 1 from public.acordos_titulos t
        where t.aluno_id = al.id
          and upper(coalesce(t.situacao,'')) in ('ABERTO','NEGOCIADO','EM_CONFIRMACAO')
          and coalesce(lower(t.status),'') <> 'quitada'
          and t.origem_encerramento is null
          and not exists (
            select 1 from public.acordo_titulo_vinculo v
              join public.acordos a on a.id = v.acordo_id
             where v.titulo_id = t.id and coalesce(v.ativo, true)
               and upper(coalesce(a.status,'')) not in ('CANCELADO','CANCELADA')));

  create temporary table _rp_titulos on commit drop as
  select t.id, t.aluno_id,
         coalesce(t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0) as valor
    from _rp_alvo b join public.acordos_titulos t on t.aluno_id = b.aluno_id
   where upper(coalesce(t.situacao,'')) in ('ABERTO','NEGOCIADO','EM_CONFIRMACAO')
     and coalesce(lower(t.status),'') <> 'quitada'
     and t.origem_encerramento is null
     and not exists (
       select 1 from public.acordo_titulo_vinculo v
         join public.acordos a on a.id = v.acordo_id
        where v.titulo_id = t.id and coalesce(v.ativo, true)
          and upper(coalesce(a.status,'')) not in ('CANCELADO','CANCELADA'));

  select count(*), round(coalesce(sum(valor),0),2), count(distinct aluno_id)
    into v_qtd, v_val, v_alunos from _rp_titulos;

  if v_qtd = 0 then
    raise notice 'reparo: nenhum aluno em tabulacao definitiva com titulo contabilizando. Nada a fazer.';
    return;
  end if;

  -- trava EXATA so quando a gestao a fixa por GUC
  if c_esp_qtd is not null and (v_qtd <> c_esp_qtd
      or (c_esp_val is not null and v_val <> c_esp_val)) then
    raise exception 'reparo: universo divergiu do fixado. Esperado % / R$ %, obtive % / R$ %.',
      c_esp_qtd, c_esp_val, v_qtd, v_val;
  end if;

  -- RECUSA se houver QUALQUER marca de pagamento no alvo
  if exists (select 1 from _rp_titulos r join public.acordos_titulos t on t.id = r.id
              where t.origem_liquidacao is not null) then
    raise exception 'reparo: ha titulo com origem_liquidacao no alvo. Abortado sem escrever.';
  end if;
  -- A GUARDA OLHA SO O QUE VAI SER ESCRITO -- parcela AINDA VIVA. Olhar todas
  -- as parcelas do aluno seria errado, e a suite provou: parcela ja DEVOLVIDA
  -- por uma aplicacao anterior pode carregar `honorarios` de um pagamento
  -- parcial REAL do passado, e isso e legitimo -- honorario ganhado nao se
  -- apaga por devolver o saldo restante. Com o escopo errado a guarda recusaria
  -- justamente os casos que ela deveria consertar.
  if exists (select 1 from _rp_alvo b
               join public.acordos a on a.aluno_id = b.aluno_id
               join public.parcelas p on p.acordo_id = a.id
              where public.parcela_viva(p.status)
                and (p.pago_em is not null or p.origem_baixa is not null
                     or coalesce(p.honorarios,0) <> 0)) then
    raise exception 'reparo: ha parcela VIVA com marca de pagamento no alvo. Abortado sem escrever.';
  end if;

  -- snapshot de quitacao ANTES, na mesma transacao
  create temporary table _rp_quitado_antes on commit drop as
  select c.id, c.quitado_em, c.origem_quitacao
    from public.casos c
   where c.aluno_id in (select aluno_id from _rp_alvo);

  insert into public._backup_backfill_efeito_sem_pagamento (lote, tabela, registro_id, aluno_id, snapshot)
  select c_lote, 'acordos_titulos', t.id, t.aluno_id, to_jsonb(t.*)
    from _rp_titulos r join public.acordos_titulos t on t.id = r.id;

  insert into public._backup_backfill_efeito_sem_pagamento (lote, tabela, registro_id, aluno_id, snapshot)
  select c_lote, 'parcelas', p.id, b.aluno_id, to_jsonb(p.*)
    from _rp_alvo b
    join public.acordos a on a.aluno_id = b.aluno_id
    join public.parcelas p on p.acordo_id = a.id
   where public.parcela_viva(p.status);

  -- APLICA PELO MOTOR, aluno por aluno. Mesmas guardas, mesma auditoria.
  for v_aluno in select aluno_id, origem from _rp_alvo loop
    v_r := public.parcela_efeito_sem_pagamento_aplicar(
      v_aluno.aluno_id,
      'reparo de 08/10/2026 autorizado pela gestao: a tabulacao ' || v_aluno.origem
        || ' nao alcancou a mensalidade porque o titulo estava fora de ABERTO/NEGOCIADO no momento da tabulacao',
      v_aluno.origem,
      false);
    v_tit_total := v_tit_total + coalesce((v_r->>'titulos_encerrados_qtd')::int, 0);
    v_val_total := v_val_total + coalesce((v_r->>'titulos_encerrados_valor')::numeric, 0);
  end loop;

  if v_tit_total <> v_qtd then
    raise exception 'reparo: o motor encerrou % titulos, o alvo tinha %. Abortado.', v_tit_total, v_qtd;
  end if;

  if exists (select 1 from _rp_titulos r join public.acordos_titulos t on t.id = r.id
              where upper(coalesce(t.situacao,'')) <> 'DEVOLVIDO') then
    raise exception 'reparo: algum titulo nao ficou DEVOLVIDO. Abortado.';
  end if;

  -- NENHUM carimbo de quitacao novo nem alterado
  if exists (
    select 1 from public.casos c join _rp_quitado_antes z on z.id = c.id
     where c.quitado_em is distinct from z.quitado_em
        or coalesce(c.origem_quitacao,'') is distinct from coalesce(z.origem_quitacao,'')) then
    raise exception 'reparo: algum caso teve quitado_em/origem_quitacao ALTERADO. Abortado.';
  end if;

  raise notice 'reparo OK -- % aluno(s), % mensalidade(s) DEVOLVIDO (R$ %); backup no lote %. Nenhuma quitacao criada.',
    v_alunos, v_tit_total, round(v_val_total,2), c_lote;
end
$parte_b$;
