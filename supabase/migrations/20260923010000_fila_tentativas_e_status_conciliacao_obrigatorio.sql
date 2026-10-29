-- FLUXO NOVO: CONTADOR DE TENTATIVAS NA FILA + STATUS_CONCILIACAO OBRIGATORIO
--
-- Duas protecoes do fluxo de pagamento NOVO, pedidas pela gestao em 22/09/2026.
-- Nao toca pagamento historico, parcela, acordo nem baixa. Nao cria indice
-- unico. Nao mexe nos 5.645 pagamentos sem estrutura nem na fila dos 53 alunos.
--
-- ---------------------------------------------------------------------------
-- 1. TENTATIVAS NA FILA
-- ---------------------------------------------------------------------------
-- `fila_pagamento_sem_vinculo` so registrava `detectado_em`. Nao dava para
-- saber quantas vezes a rodada horaria ja tentou resolver um caso, nem quando
-- foi a ultima tentativa -- e era o unico item do pedido da gestao sem nada
-- equivalente no banco.
--
-- O ponto de ancoragem e o `insert ... on conflict (pagamento_id) do update
-- ... where decisao is null` no fim de `pagamento_conciliar_um`: TODA
-- reavaliacao do motor passa por ali, tanto a primeira quanto as da rodada
-- horaria (`conciliacao_reprocessar`, chamada por `baixa_pelo_relatorio_pagamento`
-- dentro de `fluxo_pagamentos_rodar`, cron `fluxo_pagamentos_horario` :40).
--
-- Por isso o contador e um GATILHO NA TABELA, e nao uma alteracao na funcao de
-- 25 KB que escreve nela: mexer nela exigiria reescreve-la inteira, com o risco
-- que ja custou caro antes (ver memoria `create-or-replace-exige-ler-a-funcao-inteira`).
-- Qualquer caminho que escreva na fila -- motor, gestao, rotina futura -- passa
-- a contar sozinho.
--
-- ---------------------------------------------------------------------------
-- 2. STATUS_CONCILIACAO OBRIGATORIO
-- ---------------------------------------------------------------------------
-- `not null` direto e IMPOSSIVEL, por dois motivos independentes:
--
--   a) 8.955 pagamentos historicos tem NULL (R$ 12.306.066,08; o mais novo
--      entrou 11/09/2026 19:59). A gestao decidiu NAO inventar status para
--      legado, entao nao ha o que preencher antes.
--
--   b) mesmo sem legado quebraria: o status e gravado por um UPDATE dentro de
--      `_pagamento_conciliar`, que e AFTER INSERT. No instante do INSERT a
--      coluna e legitimamente nula. Um `not null` de coluna recusaria toda
--      importacao valida.
--
-- A ferramenta certa e um CONSTRAINT TRIGGER DEFERRABLE INITIALLY DEFERRED:
-- so e avaliado no COMMIT, depois de todos os AFTER terem rodado. E
-- literalmente a regra que a gestao escreveu -- "todo novo pagamento recebido
-- precisa TERMINAR A TRANSACAO com status_conciliacao definido" -- e nao olha
-- para nenhuma linha antiga, porque so dispara em INSERT novo.
--
-- ARMADILHA QUE ESTE CODIGO EVITA: num constraint trigger diferido, `new`
-- guarda a imagem da linha NO INSERT, nao no commit. Ler `new.status_conciliacao`
-- acusaria NULL em 100% dos pagamentos validos, porque o status chega depois.
-- Por isso a checagem RELE a linha da tabela.
--
-- POR QUE ERRA (raise) EM VEZ DE PREENCHER UM PADRAO: preencher silenciosamente
-- satisfaria a regra e esconderia o defeito -- um pagamento entraria com estado
-- inventado e ninguem saberia. Os 8 estados do motor cobrem todos os desfechos
-- (BAIXADO, AGUARDANDO_ACORDO, AGUARDANDO_AMARRACAO, PARCELA_JA_PAGA, REVISAO,
-- SEM_VINCULO, ACORDO_CONFIRMADO_SEM_ESTRUTURA, TITULO_ORIGINAL_LIQUIDADO) e
-- medimos 311 de 311 nos ultimos 7 dias. Se um dia faltar, e bug, e a
-- importacao tem de parar com a mensagem na tela.

-- === 1. TENTATIVAS ==========================================================

alter table public.fila_pagamento_sem_vinculo
  add column if not exists primeira_tentativa_em timestamptz,
  add column if not exists ultima_tentativa_em   timestamptz,
  add column if not exists quantidade_tentativas integer not null default 1;

comment on column public.fila_pagamento_sem_vinculo.primeira_tentativa_em is
  'Primeira tentativa real de resolucao. Gravada uma vez e NUNCA reescrita.';
comment on column public.fila_pagamento_sem_vinculo.ultima_tentativa_em is
  'Ultima reavaliacao do motor enquanto o caso estava pendente. Congela quando a decisao e tomada.';
comment on column public.fila_pagamento_sem_vinculo.quantidade_tentativas is
  'Quantas vezes o caso foi avaliado. Incrementa sozinho a cada reavaliacao de linha ainda sem decisao.';

-- HISTORICO PRESERVADO. As linhas que ja existem nao sabem quantas vezes foram
-- tentadas -- e inventar numero seria pior que admitir. Cada uma recebe 1
-- tentativa, ancorada no que a propria linha ja registrava.
update public.fila_pagamento_sem_vinculo
   set primeira_tentativa_em = coalesce(primeira_tentativa_em, detectado_em),
       ultima_tentativa_em   = coalesce(ultima_tentativa_em, decidido_em, detectado_em)
 where primeira_tentativa_em is null or ultima_tentativa_em is null;

create or replace function public._fila_pagamento_tentativa()
returns trigger
language plpgsql
as $fn$
begin
  if tg_op = 'INSERT' then
    -- Primeira tentativa: o proprio momento em que o caso foi detectado.
    new.primeira_tentativa_em := coalesce(new.primeira_tentativa_em, new.detectado_em, now());
    new.ultima_tentativa_em   := coalesce(new.ultima_tentativa_em, new.detectado_em, now());
    new.quantidade_tentativas := greatest(coalesce(new.quantidade_tentativas, 1), 1);
    return new;
  end if;

  -- A PRIMEIRA TENTATIVA NUNCA E REESCRITA, venha o UPDATE de onde vier.
  new.primeira_tentativa_em :=
    coalesce(old.primeira_tentativa_em, old.detectado_em, now());

  if old.decisao is null then
    -- Linha ainda pendente: este UPDATE E uma nova tentativa de resolucao.
    -- E por aqui que passa a rodada horaria, e tambem a escrita que marca
    -- RESOLVIDO_AUTOMATICO -- que e a tentativa que finalmente deu certo.
    new.ultima_tentativa_em   := now();
    new.quantidade_tentativas := coalesce(old.quantidade_tentativas, 1) + 1;
  else
    -- Ja decidida. Editar observacao depois nao inventa tentativa nova: o
    -- historico fica congelado para auditoria, como a gestao pediu.
    new.ultima_tentativa_em   := old.ultima_tentativa_em;
    new.quantidade_tentativas := old.quantidade_tentativas;
  end if;

  return new;
end;
$fn$;

drop trigger if exists trg_fila_pagamento_tentativa on public.fila_pagamento_sem_vinculo;
create trigger trg_fila_pagamento_tentativa
  before insert or update on public.fila_pagamento_sem_vinculo
  for each row
  execute function public._fila_pagamento_tentativa();

-- === 2. STATUS OBRIGATORIO NO FLUXO NOVO ====================================

create or replace function public._pagamento_status_conciliacao_obrigatorio()
returns trigger
language plpgsql
as $fn$
declare
  v_status text;
  v_achou  boolean;
begin
  -- RELEITURA NO COMMIT. Ver o comentario de cabecalho: `new` aqui e a imagem
  -- do INSERT, e o status so e escrito depois, pelo gatilho AFTER.
  select p.status_conciliacao, true
    into v_status, v_achou
    from public.pagamentos p
   where p.id = new.id;

  -- Linha apagada na mesma transacao: nao ha invariante a exigir.
  if not coalesce(v_achou, false) then
    return null;
  end if;

  if v_status is null then
    raise exception
      'Pagamento % terminou a transacao sem status_conciliacao. Todo pagamento novo precisa terminar BAIXADO ou com um estado de excecao explicito -- nunca nulo.',
      new.id
      using errcode = '23514',
            hint = 'A conciliacao roda em gatilho AFTER INSERT (_pagamento_conciliar). Se ela nao definiu estado, isso e defeito do motor: nao preencher a mao.';
  end if;

  return null;
end;
$fn$;

drop trigger if exists trg_pagamento_status_conciliacao_obrigatorio on public.pagamentos;
create constraint trigger trg_pagamento_status_conciliacao_obrigatorio
  after insert on public.pagamentos
  deferrable initially deferred
  for each row
  execute function public._pagamento_status_conciliacao_obrigatorio();
