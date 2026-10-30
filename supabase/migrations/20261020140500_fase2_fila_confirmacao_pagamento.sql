-- FASE 2 -- FILA UNICA DE CONFIRMACAO DE PAGAMENTOS: tabela + populador em modo SOMBRA.
--
-- FONTE DO DESENHO: docs/ESPECIFICACAO-FASE-2-CONFIRMACAO-PAGAMENTOS.md (01/10/2026).
-- Esta migration entrega o passo 2.1 daquele documento -- "tabela da fila +
-- confirmacao_fila_enfileirar_um, DESLIGADA por fluxo_pagamentos_config" -- e nada
-- alem dele. Nenhuma tela, nenhuma view de conferencia, nenhuma baixa.
--
-- POR QUE UMA LINHA POR MOVIMENTACAO: a fila atual (public.conferencia_pagamentos)
-- devolve uma linha por ALUNO com os valores somados, e por isso nao existe "uma
-- movimentacao, uma decisao". A ancora aqui e `pagamentos.id`: nao e a chave de texto,
-- nao e (aluno, data), nao e valor. `UNIQUE (pagamento_id)` e a prova estrutural de que
-- reprocessar nao duplica -- nao ha caminho de codigo que contorne um indice unico.
--
-- ============================================================================
-- O QUE ESTA MIGRATION *NAO* FAZ -- e isto e o ponto
-- ============================================================================
--   * nao da baixa, nao quita, nao altera status, nao mexe em saldo;
--   * nao escreve em pagamentos, parcelas, acordos, baixas_pagamento nem
--     links_pagamento -- o populador so faz INSERT na tabela nova;
--   * nao altera NENHUMA funcao, gatilho ou view existente. Em especial
--     `_pagamento_vincula_por_identificador_financeiro` continua byte a byte como
--     esta, com o `limit 1` do ramo CPF (debito R8, aberto e documentado). A fila
--     deixa de DEPENDER dele: refaz a propria contagem;
--   * nao cria P1/P2/P3 (secao 6 da especificacao) -- dependem de colunas que nao
--     existem em producao, ver a nota do PRE-REQUISITO abaixo;
--   * nasce DESLIGADA: `fluxo_pagamentos_config.etapa = 'fila_confirmacao_enfileirar'`
--     entra com `ligado = false`. Com a etapa desligada o populador retorna
--     ETAPA_DESLIGADA sem escrever nada.
--
-- ============================================================================
-- PRE-REQUISITO MEDIDO EM PRODUCAO EM 20/10/2026 (leitura, read-only)
-- ============================================================================
-- A especificacao declara como pre-requisito a versao
-- `20261001090357_baixa_origem_rastreavel`. Ela NAO esta em
-- supabase_migrations.schema_migrations e nao existe como arquivo no repositorio.
-- Conferido coluna a coluna:
--   * public.pagamentos: origem_vinculo, origem_vinculo_ref, origem_vinculo_em  EXISTEM
--   * public.parcelas:   origem_baixa,   origem_baixa_ref,   origem_baixa_em    EXISTEM
--   * public.baixas_pagamento: pagamento_id, origem_fluxo, origem_fluxo_evidencia  FALTAM
--   * public.vw_baixa_origem_inferida: NAO EXISTE
-- Consequencia pratica, e so ela: a terceira alternativa do passo 4 da secao 4
-- ("baixas_pagamento.pagamento_id = pagamento_id") nao e consultavel hoje. O
-- populador NAO referencia essas colunas -- nao quebra por isso, e passa a ter
-- evidencia melhor no dia em que a Fase 1 entrar.
--
-- ============================================================================
-- TRES DESVIOS DELIBERADOS DA ESPECIFICACAO -- declarados, nao escondidos
-- ============================================================================
-- Todos na mesma direcao: MENOS automatismo, MAIS olho humano. Nenhum deles cria
-- baixa, promove evidencia ou tira item da fila sem prova.
--
-- D-I. `status_conciliacao = 'BAIXADO'` NAO produz CONFIRMADO.
--   A secao 4 lista esse status como uma das portas para "nasce CONFIRMADO". A regra
--   de arquitetura da gestao e posterior e e explicita: conciliacao no CRM e baixa
--   oficial no titulo/parcela sao DOIS indicadores distintos, e BAIXADO nao e prova
--   suficiente de pagamento nem de baixa oficial. Aqui BAIXADO entra no `motivo`
--   como alerta e nada mais.
--
-- D-II. "baixa viva na parcela" NAO produz CONFIRMADO -- produz PRECISA_ANALISE.
--   Sem `baixas_pagamento.pagamento_id` (Fase 1 ausente) uma baixa viva na parcela nao
--   prova que foi ESTE credito que a originou -- e exatamente o furo R3/R5. Confirmar
--   ali seria gravar vinculo por inferencia, que a propria secao 5 proibe ("NUNCA se
--   grava pagamento_id por inferencia para preencher lacuna"). Entao vira alerta de
--   dupla baixa para analise humana.
--
-- D-III. cartao/link compativel NAO produz CONFIRMADO -- produz PRECISA_ANALISE.
--   O unico casamento possivel hoje entre um credito do extrato e um fluxo de link e
--   por aluno + valor, e a decisao D2 e taxativa: valor + data e "no maximo alerta
--   heuristico para analise", nunca trava nem prova. O objetivo do passo 5 ("pagamento
--   de cartao nao e absorvido indevidamente") fica atendido: o item nao e absorvido, e
--   olhado.
--   Resultado: o UNICO CONFIRMADO automatico e o que o banco ja amarra a este credito
--   (`parcelas.origem_baixa_ref = pagamento_id`), medido em 20/10/2026 como 1.237 de
--   1.237 refs resolvendo um `pagamentos.id`.
--
-- Decisoes da secao 10 que seguem ABERTAS e como esta migration se comporta enquanto isso:
--   10.2 PREFIXO_UNICO / NUMERO_ULBRA_UNICO como FORTE exige nova medicao -> entram
--        como FRACA (parametro `p_prefixo_como_forte` default false);
--   10.3 faixa de valor -> sem faixa inventada: igualdade exata e A_CONFIRMAR,
--        qualquer diferenca e PRECISA_ANALISE com o valor no motivo.
--
-- ROLLBACK: supabase/rollbacks/20261020140500_fase2_fila_confirmacao_pagamento.rollback.sql
-- (PITR nao esta habilitado neste projeto; o rollback e por objeto, e nenhum objeto
-- preexistente e modificado aqui -- so a linha nova em fluxo_pagamentos_config.)
--
-- NAO APLICADA. Nenhuma escrita em producao foi feita por esta frente.
begin;

-- ============================================================================
-- 1. A TABELA
-- ============================================================================
create table public.fila_confirmacao_pagamento (
  id                  uuid        primary key default gen_random_uuid(),
  pagamento_id        uuid        not null,
  chave_movimentacao  text        not null,
  estado              text        not null,
  aluno_sugerido_id   uuid,
  forca_evidencia     text        not null,
  fonte_evidencia     text        not null,
  titulo_sugerido_id  uuid,
  acordo_sugerido_id  uuid,
  parcela_sugerida_id uuid,
  valor_esperado      numeric,
  motivo              text,
  responsavel_email   text,
  criado_em           timestamptz not null default now(),
  decidido_por        text,
  decidido_em         timestamptz,
  decisao             text,
  resultado           jsonb,

  -- A ANCORA. Uma movimentacao, no maximo um item -- garantido por indice, nao por
  -- logica de aplicacao. Prova os itens 1 e 2 da validacao da gestao.
  constraint fila_confirmacao_pagamento_unico unique (pagamento_id),

  constraint fila_confirmacao_estado_valido check (
    estado in ('A_CONFIRMAR','PRECISA_ANALISE','CONFIRMADO','DUPLICADO_IGNORADO','NAO_IDENTIFICADO')),

  constraint fila_confirmacao_forca_valida check (
    forca_evidencia in ('FORTE','FRACA','SEM_IDENTIFICACAO')),

  constraint fila_confirmacao_fonte_valida check (
    fonte_evidencia in ('BOLETO_EXATO','PREFIXO_UNICO','NUMERO_ULBRA_UNICO','GESTAO_MANUAL',
                        'VINCULO_EXPLICITO','BAIXA_REGISTRADA_NA_PARCELA','CPF','NOME_UNICO',
                        'REIMPORTACAO','NENHUMA')),

  -- A REGRA DE PROMOCAO, NO BANCO: evidencia fraca nunca sai da analise. Nenhuma
  -- rotina, cron ou gatilho consegue escrever A_CONFIRMAR/CONFIRMADO sobre FRACA ou
  -- SEM_IDENTIFICACAO -- nem por bug, nem por pressa.
  constraint fila_confirmacao_so_forte_sai_da_analise check (
    estado not in ('A_CONFIRMAR','CONFIRMADO') or forca_evidencia = 'FORTE'),

  -- Identificado sem aluno nao e identificacao.
  constraint fila_confirmacao_identificado_tem_aluno check (
    estado not in ('A_CONFIRMAR','CONFIRMADO') or aluno_sugerido_id is not null),

  -- "motivo obrigatorio em texto" (secao 2) para tudo que nao e prova.
  constraint fila_confirmacao_fraca_tem_motivo check (
    forca_evidencia = 'FORTE' or nullif(btrim(motivo),'') is not null),

  -- NAO_IDENTIFICADO e decisao HUMANA registrada, com motivo (secao 3).
  constraint fila_confirmacao_nao_identificado_e_humano check (
    estado <> 'NAO_IDENTIFICADO'
    or (nullif(btrim(motivo),'') is not null and decidido_por is not null and decidido_em is not null)),

  constraint fila_confirmacao_decisao_completa check ((decidido_por is null) = (decidido_em is null)),
  constraint fila_confirmacao_decisao_tem_autor check (decisao is null or decidido_por is not null),
  constraint fila_confirmacao_chave_nao_vazia  check (nullif(btrim(chave_movimentacao),'') is not null)
);

comment on table public.fila_confirmacao_pagamento is
  'Fase 2: uma linha por MOVIMENTACAO do extrato (ancora pagamentos.id), nao uma por aluno. '
  'Sugere, nunca vincula. Evidencia FRACA nunca sai da analise -- ver o CHECK '
  'fila_confirmacao_so_forte_sai_da_analise. Desenho: docs/ESPECIFICACAO-FASE-2-CONFIRMACAO-PAGAMENTOS.md';
comment on column public.fila_confirmacao_pagamento.pagamento_id is
  'A ancora. UNIQUE: um credito, um item. Reprocessar nao duplica por causa deste indice.';
comment on column public.fila_confirmacao_pagamento.aluno_sugerido_id is
  'SUGESTAO, nunca vinculo. Nada no CRM e alterado a partir desta coluna.';
comment on column public.fila_confirmacao_pagamento.forca_evidencia is
  'FORTE | FRACA | SEM_IDENTIFICACAO. Promocao de FRACA para FORTE so por decisao humana registrada.';
comment on column public.fila_confirmacao_pagamento.titulo_sugerido_id is
  'Previsto na especificacao e deixado SEM preenchimento: nao existe tabela public.titulos '
  'em producao (20/10/2026) para a qual este id aponte. Dependencia declarada, nao inventada.';

-- Leitura da fila: filtro por estado ordenado por chegada (a tela nova usa filtros, nao abas).
create index ix_fila_confirmacao_estado on public.fila_confirmacao_pagamento (estado, criado_em desc);
-- Deteccao de reimportacao (secao 4, passo 3).
create index ix_fila_confirmacao_chave  on public.fila_confirmacao_pagamento (chave_movimentacao);
-- Itens de um aluno, para a ficha.
create index ix_fila_confirmacao_aluno  on public.fila_confirmacao_pagamento (aluno_sugerido_id)
  where aluno_sugerido_id is not null;
-- Corte "o que esta so no nome" x "o que tem prova".
create index ix_fila_confirmacao_forca  on public.fila_confirmacao_pagamento (forca_evidencia, estado);

-- ============================================================================
-- 2. GRANTS ENDURECIDOS -- o default do schema public NAO e aceito
-- ============================================================================
-- Medido em 30/09/2026 (migration 20260930232237): em `public` existe ALTER DEFAULT
-- PRIVILEGES concedendo TUDO a authenticated e service_role. Tabela nova nasce com
-- `authenticated=arwdDxtm` -- INCLUINDO D = TRUNCATE. E TRUNCATE nao e comando de RLS:
-- pg_policy.polcmd nao tem valor para TRUNCATE, entao RLS ligada barra
-- INSERT/UPDATE/DELETE e NAO barra TRUNCATE. Sem o revoke abaixo, qualquer operador
-- logado poderia apagar a fila inteira.
revoke all on table public.fila_confirmacao_pagamento from public;
revoke all on table public.fila_confirmacao_pagamento from anon;
revoke all on table public.fila_confirmacao_pagamento from authenticated;
revoke all on table public.fila_confirmacao_pagamento from service_role;

-- authenticated: SELECT e so. As linhas ainda passam pela RLS abaixo.
grant select on table public.fila_confirmacao_pagamento to authenticated;
-- service_role: escreve (e o papel do populador e da RPC), mas NAO trunca.
grant select, insert, update, delete on table public.fila_confirmacao_pagamento to service_role;

alter table public.fila_confirmacao_pagamento enable row level security;

-- Enquanto a tela nao existe, quem le e a gestao. A frente da tela declara aqui a
-- politica que precisar; esta nao e alterada por ela.
create policy fila_confirmacao_leitura_gestao
  on public.fila_confirmacao_pagamento
  for select to authenticated
  using (public.usuario_e_gestao());

-- ============================================================================
-- 3. A ETAPA NASCE DESLIGADA
-- ============================================================================
insert into public.fluxo_pagamentos_config (etapa, ligado, observacao)
values ('fila_confirmacao_enfileirar', false,
        'Fase 2 passo 2.1: fila de confirmacao em modo sombra. Nasce DESLIGADA. '
        'Ligar so com autorizacao da gestao, depois de comparar a sombra com baixa_automatica_log.')
on conflict (etapa) do nothing;

-- ============================================================================
-- 4. POPULADOR EM MODO SOMBRA -- uma movimentacao por chamada
-- ============================================================================
-- SECURITY INVOKER de proposito: nao e DEFINER, entao nao abre privilegio nenhum a
-- quem a chamar. Quem nao tem INSERT na fila nao consegue escrever nela por aqui.
-- Combinado com o revoke de EXECUTE no fim do arquivo, o front logado nao alcanca.
create or replace function public.confirmacao_fila_enfileirar_um(
  p_pagamento_id        uuid,
  p_corte               date    default date '2026-10-01',
  p_prefixo_como_forte  boolean default false
) returns jsonb
 language plpgsql
 volatile
 security invoker
 set search_path to 'public'
as $fn$
declare
  v_p           public.pagamentos;
  v_ligado      boolean;
  v_chave       text;
  v_estado      text;
  v_forca       text;
  v_fonte       text;
  v_aluno       uuid;
  v_acordo      uuid;
  v_parcela     uuid;
  v_valor_esp   numeric;
  v_motivo      text := '';
  v_cpf         text;
  v_pref        text;
  v_n           int;
  v_n2          int;
  v_inserido    boolean;
begin
  -- V-DESLIGADA: a etapa e a chave de giro. Desligada, nao escreve nada.
  select c.ligado into v_ligado
    from public.fluxo_pagamentos_config c
   where c.etapa = 'fila_confirmacao_enfileirar';
  if coalesce(v_ligado, false) is not true then
    return jsonb_build_object('ok', false, 'motivo', 'ETAPA_DESLIGADA');
  end if;

  select * into v_p from public.pagamentos where id = p_pagamento_id;
  if not found then
    return jsonb_build_object('ok', false, 'motivo', 'PAGAMENTO_INEXISTENTE');
  end if;

  -- PASSO 1 (secao 4): corte. `data_pagamento` e DATE em producao, entao o corte nao
  -- depende de fuso -- o que importa aqui, porque o CI roda em UTC e esta maquina em BRT.
  if v_p.data_pagamento is null or v_p.data_pagamento < p_corte then
    return jsonb_build_object('ok', false, 'motivo', 'FORA_DO_CORTE');
  end if;

  -- PASSO 2: idempotencia. Decisao ja tomada nao se mexe -- nem para "melhorar".
  select f.estado into v_estado
    from public.fila_confirmacao_pagamento f
   where f.pagamento_id = p_pagamento_id;
  if found then
    return jsonb_build_object('ok', true, 'ja_existia', true, 'inserido', false, 'estado', v_estado);
  end if;
  v_estado := null;

  -- PASSO 3: chave da movimentacao, derivada SO de identificadores reais do extrato,
  -- na ordem de confianca. Nunca valor + data sozinhos.
  if nullif(btrim(coalesce(v_p.numero_parcela_completo,'')),'') is not null then
    v_chave := 'BOL:' || v_p.numero_parcela_completo
            || ':' || btrim(to_char(coalesce(v_p.valor_pago,0), 'FM9999999990.00'))
            || ':' || to_char(v_p.data_pagamento, 'YYYY-MM-DD');
  elsif nullif(btrim(coalesce(v_p.titulo_numero,'')),'') is not null then
    v_chave := 'TIT:' || v_p.titulo_numero
            || ':' || coalesce(nullif(btrim(coalesce(v_p.matricula,'')),''), '-')
            || ':' || btrim(to_char(coalesce(v_p.valor_pago,0), 'FM9999999990.00'))
            || ':' || to_char(v_p.data_pagamento, 'YYYY-MM-DD');
  else
    -- Ultimo recurso. A especificacao pede <importacao_id>:<linha_do_arquivo> e nao
    -- existe coluna de linha do arquivo em `pagamentos`; usar o proprio id mantem a
    -- chave UNICA por linha, ou seja, NUNCA acusa reimportacao falsa. Sempre analise.
    v_chave := 'FRACA:' || coalesce(v_p.importacao_id::text, '-') || ':' || p_pagamento_id::text;
  end if;

  -- PASSO 4: reimportacao. A mesma movimentacao real chegando como credito novo. A
  -- chave FRACA nunca entra aqui, por construcao.
  if v_chave not like 'FRACA:%' then
    select count(*) into v_n
      from public.fila_confirmacao_pagamento f
     where f.chave_movimentacao = v_chave
       and f.estado <> 'DUPLICADO_IGNORADO';
    if v_n > 0 then
      insert into public.fila_confirmacao_pagamento
        (pagamento_id, chave_movimentacao, estado, forca_evidencia, fonte_evidencia, motivo)
      values (p_pagamento_id, v_chave, 'DUPLICADO_IGNORADO', 'SEM_IDENTIFICACAO', 'REIMPORTACAO',
        'A movimentacao ' || v_chave || ' ja tem item na fila por outro credito. '
        'Registrado para auditoria, nunca apagado.')
      on conflict (pagamento_id) do nothing;
      v_inserido := found;
      return jsonb_build_object('ok', true, 'inserido', v_inserido,
        'estado', 'DUPLICADO_IGNORADO', 'chave', v_chave);
    end if;
  end if;

  -- PASSO 5: ja existe baixa amarrada a ESTE credito? E a unica porta automatica para
  -- CONFIRMADO (desvio D-I/D-II do cabecalho). `origem_baixa_ref` guarda o pagamento_id:
  -- 1.237 de 1.237 refs resolvem um `pagamentos.id` em 20/10/2026.
  select count(*) into v_n
    from public.parcelas pc
   where pc.origem_baixa_ref = p_pagamento_id::text;
  if v_n = 1 then
    select pc.id, pc.acordo_id, pc.valor, ac.aluno_id
      into v_parcela, v_acordo, v_valor_esp, v_aluno
      from public.parcelas pc
      left join public.acordos ac on ac.id = pc.acordo_id
     where pc.origem_baixa_ref = p_pagamento_id::text;
    v_forca  := 'FORTE';
    v_fonte  := 'BAIXA_REGISTRADA_NA_PARCELA';
    v_estado := 'CONFIRMADO';
    v_motivo := 'Baixa ja registrada: a parcela aponta este credito em origem_baixa_ref.';
  elsif v_n > 1 then
    -- Rateio. A fila NAO sorteia uma parcela: ordenar nao e comprovar.
    select count(distinct ac.aluno_id) into v_n2
      from public.parcelas pc
      left join public.acordos ac on ac.id = pc.acordo_id
     where pc.origem_baixa_ref = p_pagamento_id::text;
    v_forca  := 'SEM_IDENTIFICACAO';
    v_fonte  := 'BAIXA_REGISTRADA_NA_PARCELA';
    v_estado := 'PRECISA_ANALISE';
    v_motivo := 'Este credito consta como origem de baixa em ' || v_n || ' parcelas (rateio), '
             || 'de ' || v_n2 || ' aluno(s). A fila nao escolhe uma.';
  end if;

  -- ------------------------------------------------------------------------
  -- MATRIZ DE FORCA DE EVIDENCIA (secao 2). Cada passo so roda se nada decidiu antes.
  -- ------------------------------------------------------------------------

  -- GESTAO_MANUAL: decisao humana ja tomada e registrada.
  if v_fonte is null and v_p.origem_vinculo = 'GESTAO_MANUAL' and v_p.aluno_id is not null then
    v_forca  := 'FORTE';
    v_fonte  := 'GESTAO_MANUAL';
    v_aluno  := v_p.aluno_id;
    v_motivo := 'Vinculo informado pela gestao em '
             || coalesce(to_char(v_p.origem_vinculo_em, 'DD/MM/YYYY'), 'data nao registrada')
             || ' (' || coalesce(nullif(v_p.origem_vinculo_ref,''), 'sem referencia') || ').';
  end if;

  -- Vinculo explicito ja registrado para este credito.
  -- A guarda `origem_vinculo is distinct from 'CPF'` existe porque o aluno_id gravado
  -- pelo ramo CPF do gatilho vem de `limit 1` SEM ordenacao (R8). A fila nao herda isso:
  -- credito assim cai no ramo CPF abaixo, que CONTA as fichas.
  if v_fonte is null
     and v_p.aluno_id is not null
     and v_p.origem_vinculo is distinct from 'CPF'
     and exists (select 1 from public.solicitacao_confirmacao_pagamentos s
                  where s.pagamento_id = p_pagamento_id) then
    v_forca  := 'FORTE';
    v_fonte  := 'VINCULO_EXPLICITO';
    v_aluno  := v_p.aluno_id;
    v_motivo := 'Ha solicitacao de confirmacao registrada para este credito.';
  end if;

  -- BOLETO_EXATO. E prova porque `ux_parcelas_boleto` e UNIQUE parcial: o boleto aponta
  -- uma obrigacao so.
  if v_fonte is null and nullif(btrim(coalesce(v_p.numero_parcela_completo,'')),'') is not null then
    select pc.id, pc.acordo_id, pc.valor, ac.aluno_id
      into v_parcela, v_acordo, v_valor_esp, v_aluno
      from public.parcelas pc
      left join public.acordos ac on ac.id = pc.acordo_id
     where pc.boleto = v_p.numero_parcela_completo;
    if found then
      v_forca  := 'FORTE';
      v_fonte  := 'BOLETO_EXATO';
      v_motivo := 'Boleto ' || v_p.numero_parcela_completo || ' resolve uma unica parcela.';
    end if;
  end if;

  -- PREFIXO_UNICO e NUMERO_ULBRA_UNICO. Contagem PROPRIA, nunca `limit 1`.
  -- A secao 10 item 2 e explicita: a decisao de 20/09 autorizou em tese e EXIGE NOVA
  -- MEDICAO antes de usar como FORTE. Enquanto `p_prefixo_como_forte` for false (default),
  -- a fonte e registrada e a forca fica FRACA -- o item vai para analise, nao para
  -- confirmacao. Ligar isso e decisao da gestao, e o CHECK garante que ligar no codigo
  -- errado nao promove nada sozinho.
  if v_fonte is null and length(coalesce(v_p.numero_parcela_completo,'')) = 11 then
    v_pref := substring(v_p.numero_parcela_completo, 2, 6);

    select count(distinct pc.acordo_id) into v_n
      from public.parcelas pc
     where pc.boleto like '5' || v_pref || '%';
    if v_n = 1 then
      -- `select distinct` e nao `min()`: nao existe min(uuid) em PostgreSQL, e aqui a
      -- contagem acima ja garantiu que o distinct devolve exatamente uma linha.
      select distinct pc.acordo_id into v_acordo
        from public.parcelas pc
       where pc.boleto like '5' || v_pref || '%';
      select ac.aluno_id into v_aluno from public.acordos ac where ac.id = v_acordo;
      v_fonte  := 'PREFIXO_UNICO';
      v_forca  := case when p_prefixo_como_forte then 'FORTE' else 'FRACA' end;
      v_motivo := 'Prefixo ' || v_pref || ' resolve um unico acordo.'
               || case when p_prefixo_como_forte then ''
                       else ' Tratado como FRACA: a medicao exigida pela decisao de 20/09 '
                         || 'nao foi refeita (secao 10, item 2).' end;
    else
      select count(*) into v_n2
        from public.acordos ac
       where ac.numero_ulbra is not null and lpad(ac.numero_ulbra, 6, '0') = v_pref;
      if v_n2 = 1 then
        select ac.aluno_id, ac.id into v_aluno, v_acordo
          from public.acordos ac
         where ac.numero_ulbra is not null and lpad(ac.numero_ulbra, 6, '0') = v_pref;
        v_fonte  := 'NUMERO_ULBRA_UNICO';
        v_forca  := case when p_prefixo_como_forte then 'FORTE' else 'FRACA' end;
        v_motivo := 'numero_ulbra ' || v_pref || ' resolve um unico acordo.'
                 || case when p_prefixo_como_forte then ''
                         else ' Tratado como FRACA: a medicao exigida pela decisao de 20/09 '
                           || 'nao foi refeita (secao 10, item 2).' end;
      else
        v_motivo := 'Prefixo ' || v_pref || ' nao resolveu: ' || v_n || ' acordo(s) por boleto e '
                 || v_n2 || ' por numero_ulbra. ';
      end if;
    end if;
  end if;

  -- CPF -- FORTE CONDICIONAL (D1). A fila CONTA as fichas e nao herda o `limit 1`.
  if v_fonte is null then
    v_cpf := nullif(regexp_replace(coalesce(v_p.cpf,''), '\D', '', 'g'), '');
    -- `!~ '^(.)\1*$'` descarta 00000000000 e companhia: CPF vazio virando zeros ja
    -- inventou saldo zero neste sistema antes.
    if v_cpf is not null and length(v_cpf) between 10 and 11 and v_cpf !~ '^(.)\1*$' then
      v_cpf := lpad(v_cpf, 11, '0');
      select count(*) into v_n
        from public.alunos a
       where lpad(regexp_replace(coalesce(a.cpf,''), '\D', '', 'g'), 11, '0') = v_cpf;
      if v_n = 1 then
        select a.id into v_aluno
          from public.alunos a
         where lpad(regexp_replace(coalesce(a.cpf,''), '\D', '', 'g'), 11, '0') = v_cpf;
        v_forca  := 'FORTE';
        v_fonte  := 'CPF';
        v_motivo := v_motivo || 'CPF resolve exatamente uma ficha.';
      elsif v_n = 0 then
        v_forca  := 'SEM_IDENTIFICACAO';
        v_fonte  := 'CPF';
        v_motivo := v_motivo || 'O CPF do extrato nao existe em nenhuma ficha.';
      else
        v_forca  := 'SEM_IDENTIFICACAO';
        v_fonte  := 'CPF';
        v_motivo := v_motivo || 'CPF pertence a ' || v_n || ' fichas -- a fila nao escolhe (D1).';
      end if;
    end if;
  end if;

  -- NOME -- FRACA, SEMPRE. Resolveria 788 de 794 creditos e errou o aluno em 1 dos 118
  -- casos que a gestao corrigiu a mao: nome truncado no extrato casando EXATAMENTE com
  -- outra ficha. Por isso nome unico e sugestao, nunca vinculo.
  -- Os DOIS lados passam pela MESMA funcao: `alunos.nome_normalizado` e preenchido com
  -- lower(unaccent(...)) e `normalizar_nome_pessoa` faz UPPER(translate(...)) -- formas
  -- diferentes. Normalizar na funcao nao depende de qual encheu a coluna e nao exige a
  -- extensao unaccent.
  if v_fonte is null and nullif(btrim(coalesce(v_p.aluno_nome,'')),'') is not null then
    select count(*) into v_n
      from public.alunos a
     where public.normalizar_nome_pessoa(a.nome) = public.normalizar_nome_pessoa(v_p.aluno_nome);
    if v_n = 1 then
      select a.id into v_aluno
        from public.alunos a
       where public.normalizar_nome_pessoa(a.nome) = public.normalizar_nome_pessoa(v_p.aluno_nome);
      v_forca  := 'FRACA';
      v_fonte  := 'NOME_UNICO';
      v_motivo := v_motivo || 'Identificado somente pelo nome. Nome unico nao e vinculo: '
               || 'esta regra errou o aluno em 1 dos 118 casos que a gestao corrigiu a mao. '
               || 'Exige ANALISE, nao confirmacao.';
    else
      v_motivo := v_motivo || 'O nome do extrato casa com ' || v_n || ' fichas. ';
    end if;
  end if;

  if v_fonte is null then
    v_forca  := 'SEM_IDENTIFICACAO';
    v_fonte  := 'NENHUMA';
    v_motivo := v_motivo || 'Nenhuma fonte suficiente identificou este credito.';
  end if;

  -- ------------------------------------------------------------------------
  -- ALERTAS QUE REBAIXAM PARA ANALISE (nunca promovem)
  -- ------------------------------------------------------------------------

  -- Dupla baixa: a parcela ja tem baixa viva e nada amarra essa baixa a este credito.
  if v_estado is null and v_parcela is not null then
    select count(*) into v_n
      from public.baixas_pagamento b
     where b.parcela_id = v_parcela
       and b.devolvido_em is null
       and b.status_baixa = 'REALIZADA';
    if v_n > 0 then
      v_estado := 'PRECISA_ANALISE';
      v_motivo := v_motivo || ' A parcela ja tem ' || v_n || ' baixa(s) viva(s), e sem '
               || 'baixas_pagamento.pagamento_id (Fase 1 ausente) nao da para provar que foi '
               || 'ESTE credito. Risco de dupla baixa -- confira antes.';
    end if;
  end if;

  -- Cartao/link: alerta heuristico (D2), nunca prova e nunca absorcao automatica.
  -- A fila LE o fluxo do link. Nada e escrito em links_pagamento.
  if v_estado is null and v_aluno is not null and v_p.valor_pago is not null then
    select count(*) into v_n
      from public.links_pagamento l
     where l.aluno_id = v_aluno::text
       and l.status in ('BAIXA_REALIZADA','LINK_ENVIADO_AO_ALUNO','LINK_PRONTO_PARA_ENVIO','SOLICITADO_LINK')
       and coalesce(l.valor_pago, l.valor) = v_p.valor_pago;
    if v_n > 0 then
      v_estado := 'PRECISA_ANALISE';
      v_motivo := v_motivo || ' Existe fluxo de link/cartao compativel (mesmo aluno e valor) em '
               || v_n || ' registro(s). Valor+data e alerta, nao prova (D2): confira dupla baixa.';
    end if;
  end if;

  -- BAIXADO no CRM e alerta, nao prova (desvio D-I). Nunca muda o estado por si.
  if v_p.status_conciliacao = 'BAIXADO' then
    v_motivo := v_motivo || ' Atencao: status_conciliacao=BAIXADO no CRM. Conciliacao no CRM nao '
             || 'e baixa oficial -- este status nao conta como prova aqui.';
  end if;

  -- Valor divergente. Sem faixa inventada: a faixa e decisao pendente da gestao
  -- (secao 10, item 3), entao igualdade exata e o criterio, e qualquer diferenca vai
  -- para analise com os dois numeros no motivo.
  if v_estado is null and v_valor_esp is not null
     and v_p.valor_pago is distinct from v_valor_esp then
    v_estado := 'PRECISA_ANALISE';
    v_motivo := v_motivo || ' Valor divergente: pago '
             || btrim(to_char(coalesce(v_p.valor_pago,0), 'FM9999999990.00'))
             || ', esperado ' || btrim(to_char(v_valor_esp, 'FM9999999990.00'))
             || '. Faixa de tolerancia pendente de decisao da gestao.';
  end if;

  if v_estado is null then
    v_estado := case when v_forca = 'FORTE' then 'A_CONFIRMAR' else 'PRECISA_ANALISE' end;
  end if;

  -- GUARDA FINAL, espelho do CHECK: nada sai da analise sem FORTE e sem aluno resolvido.
  if v_estado in ('A_CONFIRMAR','CONFIRMADO') and (v_forca <> 'FORTE' or v_aluno is null) then
    v_estado := 'PRECISA_ANALISE';
    v_motivo := v_motivo || ' Mantido em analise: '
             || case when v_forca <> 'FORTE' then 'a evidencia nao e FORTE. ' else '' end
             || case when v_aluno is null then 'o aluno nao ficou resolvido. ' else '' end;
  end if;

  -- IDEMPOTENCIA POR INDICE, nao por logica: se outra transacao inseriu primeiro,
  -- o ON CONFLICT nao duplica e NAO sobrescreve a decisao que ja esta la.
  insert into public.fila_confirmacao_pagamento
    (pagamento_id, chave_movimentacao, estado, aluno_sugerido_id, forca_evidencia,
     fonte_evidencia, acordo_sugerido_id, parcela_sugerida_id, valor_esperado, motivo)
  values (p_pagamento_id, v_chave, v_estado, v_aluno, v_forca,
          v_fonte, v_acordo, v_parcela, v_valor_esp, nullif(btrim(v_motivo),''))
  on conflict (pagamento_id) do nothing;
  v_inserido := found;

  return jsonb_build_object(
    'ok', true, 'inserido', v_inserido, 'estado', v_estado,
    'forca', v_forca, 'fonte', v_fonte, 'chave', v_chave,
    'aluno_sugerido_id', v_aluno, 'parcela_sugerida_id', v_parcela);
end;
$fn$;

comment on function public.confirmacao_fila_enfileirar_um(uuid, date, boolean) is
  'Fase 2 modo sombra: classifica UMA movimentacao e insere UM item na fila. So faz INSERT '
  'em fila_confirmacao_pagamento -- nao da baixa, nao promove evidencia fraca e nao escreve '
  'em nenhuma outra tabela. Desligada por fluxo_pagamentos_config.fila_confirmacao_enfileirar.';

-- Lote: so varre e chama a de cima. Mesma funcao, mesma regra, uma linha por movimentacao.
create or replace function public.confirmacao_fila_enfileirar_lote(
  p_corte               date    default date '2026-10-01',
  p_limite              integer default 500,
  p_prefixo_como_forte  boolean default false
) returns jsonb
 language plpgsql
 volatile
 security invoker
 set search_path to 'public'
as $fn$
declare
  v_ligado  boolean;
  v_r       record;
  v_res     jsonb;
  v_vistos  int := 0;
  v_novos   int := 0;
  v_estados jsonb := '{}'::jsonb;
  v_e       text;
begin
  select c.ligado into v_ligado
    from public.fluxo_pagamentos_config c
   where c.etapa = 'fila_confirmacao_enfileirar';
  if coalesce(v_ligado, false) is not true then
    return jsonb_build_object('ok', false, 'motivo', 'ETAPA_DESLIGADA');
  end if;

  for v_r in
    select g.id
      from public.pagamentos g
     where g.data_pagamento >= p_corte
       and not exists (select 1 from public.fila_confirmacao_pagamento f where f.pagamento_id = g.id)
     order by g.data_pagamento, g.id
     limit greatest(coalesce(p_limite, 500), 0)
  loop
    v_res   := public.confirmacao_fila_enfileirar_um(v_r.id, p_corte, p_prefixo_como_forte);
    v_vistos := v_vistos + 1;
    if coalesce((v_res->>'inserido')::boolean, false) then
      v_novos := v_novos + 1;
    end if;
    v_e := coalesce(v_res->>'estado', 'IGNORADO:' || coalesce(v_res->>'motivo','?'));
    v_estados := jsonb_set(v_estados, array[v_e],
                   to_jsonb(coalesce((v_estados->>v_e)::int, 0) + 1));
  end loop;

  return jsonb_build_object('ok', true, 'corte', p_corte,
    'movimentacoes_vistas', v_vistos, 'itens_novos', v_novos, 'por_estado', v_estados);
end;
$fn$;

comment on function public.confirmacao_fila_enfileirar_lote(date, integer, boolean) is
  'Fase 2 modo sombra: varre pagamentos a partir do corte e chama confirmacao_fila_enfileirar_um '
  'em cada movimentacao. Nenhuma escrita fora de fila_confirmacao_pagamento.';

-- Funcao nova HERDA EXECUTE para authenticated pelo default do schema. Revogar e
-- obrigatorio: sem isto qualquer usuario logado poderia enfileirar.
revoke all on function public.confirmacao_fila_enfileirar_um(uuid, date, boolean)      from public, anon, authenticated;
revoke all on function public.confirmacao_fila_enfileirar_lote(date, integer, boolean) from public, anon, authenticated;
grant execute on function public.confirmacao_fila_enfileirar_um(uuid, date, boolean)      to service_role;
grant execute on function public.confirmacao_fila_enfileirar_lote(date, integer, boolean) to service_role;

-- ============================================================================
-- 5. GUARDA: a migration falha se o resultado nao for exatamente o pretendido.
-- Le relacl/pg_proc.proacl CRU, nao o information_schema -- que esconde PUBLIC.
-- ============================================================================
do $do$
declare v_acl text; v_pol int; v_f text;
begin
  select coalesce(array_to_string(c.relacl, ' | '), '(sem acl)') into v_acl
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = 'fila_confirmacao_pagamento';

  if has_table_privilege('authenticated','public.fila_confirmacao_pagamento','TRUNCATE') then
    raise exception 'ABORTA: authenticated ficou com TRUNCATE na fila. ACL=%', v_acl;
  end if;
  if has_table_privilege('authenticated','public.fila_confirmacao_pagamento','INSERT')
     or has_table_privilege('authenticated','public.fila_confirmacao_pagamento','UPDATE')
     or has_table_privilege('authenticated','public.fila_confirmacao_pagamento','DELETE') then
    raise exception 'ABORTA: authenticated ficou com escrita na fila. ACL=%', v_acl;
  end if;
  if not has_table_privilege('authenticated','public.fila_confirmacao_pagamento','SELECT') then
    raise exception 'ABORTA: authenticated perdeu SELECT -- a tela nao leria a fila. ACL=%', v_acl;
  end if;
  if position('authenticated=r/' in v_acl) = 0 then
    raise exception 'ABORTA: authenticated nao ficou exatamente em r. ACL=%', v_acl;
  end if;
  if has_table_privilege('anon','public.fila_confirmacao_pagamento','SELECT') then
    raise exception 'ABORTA: anon enxerga a fila. ACL=%', v_acl;
  end if;
  if has_table_privilege('service_role','public.fila_confirmacao_pagamento','TRUNCATE') then
    raise exception 'ABORTA: service_role ficou com TRUNCATE. ACL=%', v_acl;
  end if;
  if not has_table_privilege('service_role','public.fila_confirmacao_pagamento','INSERT') then
    raise exception 'ABORTA: service_role perdeu INSERT -- o populador nao escreveria. ACL=%', v_acl;
  end if;

  if not (select c.relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace
           where n.nspname='public' and c.relname='fila_confirmacao_pagamento') then
    raise exception 'ABORTA: RLS nao ficou ligada na fila';
  end if;

  select count(*) into v_pol
    from pg_policy p join pg_class c on c.oid = p.polrelid
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname='public' and c.relname='fila_confirmacao_pagamento';
  if v_pol <> 1 then
    raise exception 'ABORTA: esperava 1 politica na fila, achei %', v_pol;
  end if;

  -- EXECUTE: `has_function_privilege` ja considera o grant a PUBLIC, entao estes dois
  -- testes provam que nem o papel logado nem o anonimo alcancam o populador -- por grant
  -- direto OU por PUBLIC. `proacl is null` significa "default", e o default aqui e
  -- EXECUTE para PUBLIC: tambem reprova.
  for v_f in select unnest(array[
      'public.confirmacao_fila_enfileirar_um(uuid,date,boolean)',
      'public.confirmacao_fila_enfileirar_lote(date,integer,boolean)']) loop
    if has_function_privilege('authenticated', v_f, 'EXECUTE') then
      raise exception 'ABORTA: authenticated executa %', v_f;
    end if;
    if has_function_privilege('anon', v_f, 'EXECUTE') then
      raise exception 'ABORTA: anon executa %', v_f;
    end if;
    if not has_function_privilege('service_role', v_f, 'EXECUTE') then
      raise exception 'ABORTA: service_role nao executa % -- o populador nao rodaria', v_f;
    end if;
  end loop;

  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public'
                and p.proname in ('confirmacao_fila_enfileirar_um','confirmacao_fila_enfileirar_lote')
                and p.proacl is null) then
    raise exception 'ABORTA: populador ficou com proacl nulo (default = EXECUTE para PUBLIC)';
  end if;

  if (select count(*) from public.fila_confirmacao_pagamento) <> 0 then
    raise exception 'ABORTA: a fila nasceu com linha. Esta migration nao popula nada.';
  end if;
  if (select ligado from public.fluxo_pagamentos_config where etapa='fila_confirmacao_enfileirar') is not false then
    raise exception 'ABORTA: a etapa nao ficou desligada.';
  end if;

  raise notice 'OK: fila criada vazia, etapa DESLIGADA, authenticated=r (sem TRUNCATE), RLS ligada.';
end
$do$;

commit;
