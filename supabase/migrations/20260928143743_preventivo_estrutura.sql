-- =============================================================================
-- PREVENTIVO — estrutura própria, isolada da cobrança
-- =============================================================================
--
-- O Preventivo é uma operação SEPARADA da cobrança: orienta o aluno a pagar a
-- mensalidade no WebAluno ANTES de o título virar dívida. Não cobra honorário,
-- não cria caso, não distribui operador, não entra em fidelização, acordo,
-- fila, meta ou resultado da cobrança.
--
-- POR QUE ESTRUTURA PRÓPRIA (prefixo `prev_`) E NÃO REUSO:
--   as tabelas da cobrança (`casos`, `acordos`, `acordos_titulos`, `alunos`)
--   têm GATILHO. Escrever nelas dispara reavaliação de caso, nivelamento,
--   reposição de carteira e recálculo de saldo. Qualquer reuso ali levaria o
--   Preventivo a mexer na cobrança por efeito colateral, que é exatamente o
--   que a gestão proibiu. Nenhuma tabela deste arquivo tem chave estrangeira
--   para tabela da cobrança, e nenhum gatilho aqui escreve fora do prefixo
--   `prev_`.
--
-- O ALUNO PODE EXISTIR NAS DUAS OPERAÇÕES. A separação é POR TÍTULO: a
-- identidade de um título preventivo é (carteira, matrícula Prime, documento).
-- Nada aqui atualiza "todas as pendências do aluno" — ver
-- `prev_titulo_snapshot`, que é por título, nunca por pessoa.
--
-- ACESSO: somente a Amanda da gestão (amanda.seibel@aelbra.com.br), conferido
-- no BANCO por `public.preventivo_e_gestao()`, em RLS e dentro de cada RPC.
-- Amanda ADM (cobranca07@aelbra.com.br) NÃO tem acesso — é outra conta, outro
-- perfil. A trava da interface é só conforto; a que vale é esta.
--
-- Nada aqui é aplicado automaticamente em produção. Reversão em
-- `supabase/rollbacks/20260928143743_preventivo_estrutura.sql`.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. PORTÃO DE ACESSO
-- -----------------------------------------------------------------------------
-- Mesma forma de `app_pode_borderos_importacoes()` (27/07): portão INTERNO por
-- e-mail do JWT, nunca `revoke` de `authenticated` — revogar derrubaria a
-- própria tela da gestão (erro já cometido em 12/09, ver
-- `restringir-a-gestao-e-portao-interno-nunca-revoke-de-authenticated`).
create or replace function public.preventivo_e_gestao()
returns boolean
language plpgsql
stable
security definer
set search_path to 'public'
as $$
declare em text := lower(coalesce((auth.jwt() ->> 'email'), ''));
begin
  if em = '' then
    -- sem usuário final: só chamada interna de sistema (Edge Function com
    -- service_role, cron). Nunca `anon`.
    return current_user in ('postgres', 'supabase_admin', 'service_role');
  end if;
  return em = 'amanda.seibel@aelbra.com.br'
     and exists (select 1 from public.usuarios u where lower(u.email) = em and u.ativo is true);
end;
$$;

comment on function public.preventivo_e_gestao() is
  'Preventivo: verdadeiro somente para a Amanda da gestão (amanda.seibel@aelbra.com.br, perfil gerencia, ativa) ou para chamada interna de sistema. Amanda ADM e demais perfis NÃO passam.';

revoke all on function public.preventivo_e_gestao() from public;
grant execute on function public.preventivo_e_gestao() to authenticated, service_role;

-- "Hoje" do Preventivo é sempre data de calendário em America/Sao_Paulo. Sem
-- isto, um título vencido ontem vira "vence hoje" entre 21h e 24h (UTC-3).
create or replace function public.preventivo_hoje()
returns date
language sql
stable
set search_path to 'public'
as $$ select ((now() at time zone 'America/Sao_Paulo')::date) $$;

comment on function public.preventivo_hoje() is
  'Data de calendário em America/Sao_Paulo. Toda regra de janela do Preventivo usa esta função, nunca current_date (que é UTC no servidor).';

grant execute on function public.preventivo_hoje() to authenticated, service_role;

-- Limite de permanência no Preventivo: 31 dias de atraso, em dias de
-- calendário São Paulo. No dia 31 ainda é preventivo; no 32 não é mais.
create or replace function public.preventivo_limite_dias()
returns integer language sql immutable as $$ select 31 $$;

create or replace function public.preventivo_dias_atraso(p_vencimento date)
returns integer
language sql
stable
set search_path to 'public'
as $$ select (public.preventivo_hoje() - p_vencimento) $$;

create or replace function public.preventivo_na_janela(p_vencimento date)
returns boolean
language sql
stable
set search_path to 'public'
as $$ select public.preventivo_dias_atraso(p_vencimento) <= public.preventivo_limite_dias() $$;

comment on function public.preventivo_na_janela(date) is
  'Título está na janela preventiva enquanto o atraso for <= 31 dias de calendário (America/Sao_Paulo). Título a vencer tem atraso negativo e também está na janela. Passou de 31, sai das ações novas e o histórico fica para consulta.';

grant execute on function public.preventivo_limite_dias() to authenticated, service_role;
grant execute on function public.preventivo_dias_atraso(date) to authenticated, service_role;
grant execute on function public.preventivo_na_janela(date) to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- 2. CARTEIRA
-- -----------------------------------------------------------------------------
create table if not exists public.prev_carteira (
  id             uuid primary key default gen_random_uuid(),
  nome           text not null,
  descricao      text,
  -- janela de vencimento ESCOLHIDA pela gestão no momento de criar a carteira.
  -- Não há antecedência padrão embutida: quem decide o recorte é quem opera.
  venc_de        date not null,
  venc_ate       date not null,
  criada_por     text not null,
  criada_em      timestamptz not null default now(),
  encerrada_em   timestamptz,
  constraint prev_carteira_nome_unico unique (nome),
  constraint prev_carteira_janela_coerente check (venc_ate >= venc_de)
);

comment on table public.prev_carteira is
  'Carteira preventiva: um recorte nomeado de títulos por janela de vencimento. O saldo em aberto informado pelo arquivo é preservado título a título (prev_titulo.saldo_informado), nunca recalculado.';

-- -----------------------------------------------------------------------------
-- 3. LOTE DE IMPORTAÇÃO
-- -----------------------------------------------------------------------------
create table if not exists public.prev_lote (
  id             uuid primary key default gen_random_uuid(),
  carteira_id    uuid not null references public.prev_carteira(id) on delete cascade,
  nome           text not null,
  arquivo_nome   text,
  mapeamento     jsonb not null default '{}'::jsonb,
  resumo         jsonb not null default '{}'::jsonb,
  conteudo_hash  text,
  status         text not null default 'CONFIRMADO'
                 check (status in ('CONFIRMADO', 'CANCELADO')),
  criado_por     text not null,
  criado_em      timestamptz not null default now(),
  constraint prev_lote_nome_unico unique (carteira_id, nome)
);

comment on column public.prev_lote.conteudo_hash is
  'md5 do conteúdo normalizado do arquivo. Reimportar o mesmo arquivo é permitido (atualiza), mas o hash igual é avisado na prévia para a gestão saber que não há novidade.';

-- Linhas que o arquivo trouxe e a importação RECUSOU, com o motivo. Ficam
-- gravadas: "linha recusada e seu motivo" é entregável, não log de tela.
create table if not exists public.prev_lote_recusa (
  id          bigserial primary key,
  lote_id     uuid not null references public.prev_lote(id) on delete cascade,
  linha       integer,
  motivo      text not null,
  dados       jsonb
);

-- -----------------------------------------------------------------------------
-- 4. TÍTULO PREVENTIVO
-- -----------------------------------------------------------------------------
-- CHAVE: (carteira, matrícula Prime, documento). Nome NUNCA entra na chave —
-- nome é do pagador/homônimo e já causou 10 baixas erradas na cobrança em
-- 08/09. `unidade` fica na tabela porque distingue título quando o relatório
-- de origem repete documento entre unidades; se isso acontecer, a importação
-- recusa a linha em vez de fundir dois títulos (ver RPC de importação).
create table if not exists public.prev_titulo (
  id                uuid primary key default gen_random_uuid(),
  carteira_id       uuid not null references public.prev_carteira(id) on delete cascade,
  matricula_prime   text not null,

  -- IDENTIDADE DENTRO DA CARTEIRA. Medido no relatório real de 28/09/2026
  -- ("relatorio_inadimplencia 28.09.csv", 3.494 linhas): o relatório de
  -- inadimplência da ULBRA NÃO traz identificador de título — não tem boleto
  -- nem documentNumber. Traz `Código` (= matrícula), `Dt Vcto` e
  -- `Vcto Origem`. Então a identidade do título DENTRO da carteira é o que o
  -- arquivo sabe dizer: `chave_arquivo`. Quando o arquivo trouxer um
  -- identificador de título, `documento` é preenchido e vira a chave.
  documento         text,
  vencimento        date not null,
  vencimento_origem date,
  chave_arquivo     text not null,

  unidade           text,
  contrato          text,
  aluno_nome        text not null,
  cpf               text,
  competencia       text,

  -- VALOR INFORMADO PELO ARQUIVO. `saldo_informado` é o "Saldo Original" do
  -- relatório: ali a palavra saldo tem dono e definição (é o relatório de
  -- inadimplência da ULBRA que a chama assim). NÃO confundir com nada vindo
  -- da API — ver os campos `valor_fonte_*` abaixo.
  valor_original    numeric(14,2) not null,
  saldo_informado   numeric(14,2) not null,
  saldo_informado_atualizado numeric(14,2),
  situacao_origem   text,
  -- O sufixo `_aluno` NÃO é enfeite. `public.propagar_nome_usuario()` (rotina
  -- viva em produção) varre `information_schema` atrás de qualquer coluna com
  -- "email" no nome que tenha uma irmã "nome", e sobrescreve a irmã com o nome
  -- de um OPERADOR. Ela pula o que tem "aluno" no nome da coluna. Sem este
  -- sufixo, uma coluna `nome` acrescentada aqui no futuro faria uma rotina da
  -- cobrança escrever dentro do Preventivo. Mesma razão para nunca existir
  -- `aluno_id` aqui: `public.mesclar_aluno_duplicado()` varre todas as tabelas
  -- com essa coluna exata.
  celular_aluno     text,
  email_aluno       text,
  -- quantos contatos DIFERENTES a linha do arquivo trazia. > 1 significa
  -- ambíguo: o contato fica vazio e o aluno é separado do público com motivo.
  celulares_no_arquivo integer not null default 0,
  emails_no_arquivo    integer not null default 0,
  lote_origem_id    uuid references public.prev_lote(id) on delete set null,
  lote_ultimo_id    uuid references public.prev_lote(id) on delete set null,
  criado_em         timestamptz not null default now(),
  atualizado_em     timestamptz not null default now(),

  -- VÍNCULO COM O TÍTULO DO PRIME. Não é suposição: só vira UNICO quando
  -- existe exatamente UM título do aluno com aquele vencimento no extrato.
  vinculo_prime     text not null default 'PENDENTE'
                    check (vinculo_prime in ('PENDENTE', 'UNICO', 'AMBIGUO', 'NAO_ENCONTRADO')),
  documento_prime   text,
  candidatos_prime  integer,

  -- VALORES LIDOS DA API, com o nome do campo da API. Nenhum deles é saldo:
  -- a API não expõe saldo em aberto (ver migration de sincronização).
  valor_fonte           numeric(14,2),
  valor_fonte_bruto     numeric(14,2),
  valor_fonte_corrigido numeric(14,2),
  portador_atual    integer,
  portador_nome     text,
  sinc_em           timestamptz,
  sinc_id           uuid,
  presente_no_extrato boolean,

  status            text not null default 'ATIVO'
                    check (status in ('ATIVO', 'FORA_DA_JANELA')),
  saiu_em           date,
  saida_motivo      text,

  constraint prev_titulo_chave unique (carteira_id, matricula_prime, chave_arquivo)
);

comment on table public.prev_titulo is
  'Um título de mensalidade dentro de uma carteira preventiva, do jeito que o ARQUIVO importado o descreve. A carteira é definida pelo arquivo da gestão — nada entra aqui por varredura de portador.';
comment on column public.prev_titulo.chave_arquivo is
  'Identidade do título dentro da carteira. É `documento` quando o arquivo traz identificador de título; senão é vencimento|vencimento_origem, que foi o que o relatório real de 28/09/2026 tinha para distinguir dois títulos do mesmo aluno.';
comment on column public.prev_titulo.vencimento is
  'O vencimento ATUAL do boleto ("Dt Vcto" no relatório). É ele que rege a janela de 31 dias e é ele que casa com o `dueDate` da API. MEDIDO em 28/09/2026 nas 35 linhas do relatório em que as duas datas divergem: 21 tinham o aluno no espelho e 21 casaram por Dt Vcto; só 3 casaram por Vcto Origem, e nenhuma casou SÓ por Vcto Origem.';
comment on column public.prev_titulo.vencimento_origem is
  'O vencimento original da mensalidade ("Vcto Origem"). Serve para distinguir linhas do mesmo aluno e como competência. NÃO rege a janela e NÃO casa com a API quando o boleto foi reemitido.';
comment on column public.prev_titulo.saldo_informado is
  'Saldo em aberto conforme o ARQUIVO importado, na data da extração. Nunca é reescrito por sincronização — é o valor de entrada da carteira.';
comment on column public.prev_titulo.vinculo_prime is
  'PENDENTE (ainda não consultado) · UNICO (exatamente um título do aluno com aquele vencimento no extrato) · AMBIGUO (mais de um candidato — fica pendente, NUNCA se escolhe por suposição) · NAO_ENCONTRADO. Só UNICO entra em público de ação e em conta de variação.';
comment on column public.prev_titulo.valor_fonte is
  'netAmount do título na API, na última consulta. NÃO É SALDO EM ABERTO: é o valor do título (principal − desconto + multa + juros + honorário). A API não expõe saldo nem situação. NULL = nunca consultado com vínculo único.';
comment on column public.prev_titulo.valor_fonte_corrigido is
  'paidAmount cru. GUARDADO PARA ESTUDO, NUNCA SOMADO COMO CAIXA. Medido 28/09/2026 contra variável independente (o relatório de inadimplência do dia): entre 101 títulos COMPROVADAMENTE EM ABERTO, 61 tinham paidAmount IGUAL ao netAmount — a assinatura que alguém leria como "pagou o valor cheio".';
comment on column public.prev_titulo.status is
  'ATIVO enquanto na janela (atraso <= 31 dias corridos sobre o VENCIMENTO ATUAL, America/Sao_Paulo). FORA_DA_JANELA sai das ações NOVAS e mantém todo o histórico para consulta. O título NÃO é transferido para a cobrança por esta rotina.';

create index if not exists prev_titulo_carteira_status_idx on public.prev_titulo (carteira_id, status);
create index if not exists prev_titulo_vencimento_idx      on public.prev_titulo (carteira_id, vencimento);
create index if not exists prev_titulo_matricula_idx       on public.prev_titulo (matricula_prime);
create index if not exists prev_titulo_documento_idx       on public.prev_titulo (documento_prime);
create index if not exists prev_titulo_vinculo_idx         on public.prev_titulo (carteira_id, vinculo_prime);

-- Qual lote trouxe qual título. O mesmo título pode aparecer em vários lotes;
-- o consolidado conta pelo TÍTULO, nunca pela linha de lote — é o que impede
-- dobra de valor no painel.
create table if not exists public.prev_titulo_lote (
  titulo_id    uuid not null references public.prev_titulo(id) on delete cascade,
  lote_id      uuid not null references public.prev_lote(id) on delete cascade,
  primeira_vez boolean not null default false,
  visto_em     timestamptz not null default now(),
  primary key (titulo_id, lote_id)
);

-- -----------------------------------------------------------------------------
-- 5. SINCRONIZAÇÃO COM O PRIME
-- -----------------------------------------------------------------------------
create table if not exists public.prev_sinc (
  id             uuid primary key default gen_random_uuid(),
  carteira_id    uuid references public.prev_carteira(id) on delete cascade,
  origem         text not null check (origem in ('cron', 'manual')),
  solicitado_por text,
  iniciado_em    timestamptz not null default now(),
  concluido_em   timestamptz,
  status         text not null default 'EM_ANDAMENTO'
                 check (status in ('EM_ANDAMENTO', 'CONCLUIDA', 'FALHOU')),
  alvos          integer not null default 0,
  consultados    integer not null default 0,
  erros          integer not null default 0,
  mensagem       text
);

comment on table public.prev_sinc is
  'Um ciclo de consulta ao Prime. A tela mostra a ÚLTIMA CONCLUÍDA com sucesso — ciclo que falhou não vira "atualizado".';

create index if not exists prev_sinc_carteira_idx on public.prev_sinc (carteira_id, iniciado_em desc);

-- Fila própria, restrita às matrículas da carteira preventiva. NÃO reusa
-- `prime_extrato_fila`: aquela fila varre os 17.7 mil alunos da base e roda no
-- mutirão de sábado (cron `prime_extrato_mutirao`, `*/2 2-23 * * 6`). Enfileirar
-- o Preventivo lá significaria (a) esperar até sábado, (b) empurrar a operação
-- da cobrança para dentro de uma varredura diária que ela não pede.
create table if not exists public.prev_sinc_fila (
  sinc_id     uuid not null references public.prev_sinc(id) on delete cascade,
  matricula   text not null,
  coletado_em timestamptz,
  tentativas  integer not null default 0,
  ultimo_erro text,
  primary key (sinc_id, matricula)
);

create index if not exists prev_sinc_fila_pendente_idx
  on public.prev_sinc_fila (sinc_id) where coletado_em is null;

-- Foto do título a cada ciclo. É append-only e é daqui que sai TODO evento
-- financeiro — nunca de uma comparação com "o que eu lembrava".
create table if not exists public.prev_titulo_snapshot (
  id                  bigserial primary key,
  sinc_id             uuid not null references public.prev_sinc(id) on delete cascade,
  titulo_id           uuid not null references public.prev_titulo(id) on delete cascade,
  observado_em        timestamptz not null default now(),
  presente_no_extrato boolean not null,
  valor_fonte           numeric(14,2),
  valor_fonte_bruto     numeric(14,2),
  valor_fonte_corrigido numeric(14,2),
  vencimento          date,
  portador            integer,
  liquidado_em_prime  date,
  constraint prev_snapshot_unico unique (sinc_id, titulo_id)
);

comment on column public.prev_titulo_snapshot.valor_fonte_corrigido is
  'paidAmount cru do Prime. GUARDADO PARA ESTUDO, NUNCA SOMADO COMO CAIXA: medido em 28/09/2026 que paidAmount é valor de tabela/dívida corrigida — aparece como o DOBRO exato do principal em títulos vencidos e MAIOR que o principal em títulos ainda a vencer. Ver docs/integracoes/prime-api.md.';
comment on column public.prev_titulo_snapshot.liquidado_em_prime is
  'paymentDate cru do Prime. GUARDADO, NUNCA INTERPRETADO COMO PAGAMENTO: medido em 28/09/2026 que 100% das linhas do extrato têm paymentDate preenchido, inclusive títulos a vencer (0 de 302.477 linhas do portador 95 com paymentDate nulo). Ver docs/integracoes/prime-api.md.';

-- -----------------------------------------------------------------------------
-- 6. EVENTO FINANCEIRO OBSERVADO
-- -----------------------------------------------------------------------------
-- NENHUM destes tipos é "pagamento" por si. A API do Prime não expõe evento de
-- pagamento, situação do título nem saldo em aberto (conferido ao vivo em
-- 28/09/2026: `financialStatement` tem 13 campos, nenhum de situação). O que
-- observamos é MOVIMENTO DE SALDO. Redução de saldo NÃO é dinheiro recebido:
-- pode ser cancelamento, bolsa, renegociação ou ajuste. Por isso o tipo vem
-- separado e `e_pagamento_comprovado` existe, começa sempre falso, e só muda
-- quando houver fonte que prove data e valor do pagamento.
create table if not exists public.prev_evento (
  id                     bigserial primary key,
  titulo_id              uuid not null references public.prev_titulo(id) on delete cascade,
  sinc_id                uuid not null references public.prev_sinc(id) on delete cascade,
  tipo                   text not null check (tipo in (
                           'VALOR_FONTE_ZEROU',
                           'VALOR_FONTE_CAIU',
                           'VALOR_FONTE_SUBIU',
                           'MUDANCA_DE_PORTADOR',
                           'AUSENTE_NO_EXTRATO',
                           'RETORNO_AO_EXTRATO',
                           'VINCULO_AMBIGUO',
                           'VINCULO_RESOLVIDO')),
  valor_fonte_antes      numeric(14,2),
  valor_fonte_depois     numeric(14,2),
  valor_delta            numeric(14,2),
  observado_em           timestamptz not null default now(),
  e_pagamento_comprovado boolean not null default false,
  detalhe                jsonb not null default '{}'::jsonb,
  chave                  text not null,
  constraint prev_evento_chave_unica unique (chave)
);

comment on table public.prev_evento is
  'ALTERAÇÃO DE VALOR NA FONTE, título a título, entre duas consultas à API. Não é registro de pagamento e não é movimento de saldo: o que muda é o `netAmount` do título, que é o VALOR do título, não um saldo em aberto — a API não expõe saldo. Reconsultar não duplica: `chave` é única.';
comment on column public.prev_evento.valor_fonte_antes is
  'netAmount na consulta anterior. A palavra saldo não aparece aqui de propósito.';
comment on column public.prev_evento.e_pagamento_comprovado is
  'Sempre falso hoje, e não há caminho no código que o torne verdadeiro. Provado em 28/09/2026 com variável independente (o relatório de inadimplência do próprio dia, que diz quem está EM ABERTO): dos 101 títulos comprovadamente em aberto, 101 tinham paymentDate preenchido, 19 com data POSTERIOR ao vencimento, e 61 tinham paidAmount igual ao netAmount. Nenhum campo da API separa aberto de pago.';

create index if not exists prev_evento_titulo_idx on public.prev_evento (titulo_id, observado_em desc);
create index if not exists prev_evento_tipo_idx   on public.prev_evento (tipo, observado_em desc);

-- -----------------------------------------------------------------------------
-- 7. AÇÕES E EXPORTAÇÃO PARA A MENSAGERIA
-- -----------------------------------------------------------------------------
-- EXPORTAR NÃO É ENVIAR. Os quatro estados existem para que "exportei a lista"
-- nunca seja lido como "a pessoa recebeu". Nada neste módulo dispara mensagem:
-- o envio é feito pelo CRM de mensageria, fora daqui.
create table if not exists public.prev_acao (
  id                   uuid primary key default gen_random_uuid(),
  carteira_id          uuid not null references public.prev_carteira(id) on delete cascade,
  nome                 text not null,
  canal                text not null check (canal in ('WHATSAPP', 'EMAIL')),
  filtros              jsonb not null default '{}'::jsonb,
  estado               text not null default 'PREPARADA'
                       check (estado in ('PREPARADA', 'EXPORTADA', 'ENVIO_CONFIRMADO', 'CANCELADA')),
  -- qual foto financeira a gestão tinha na tela quando montou o público
  sinc_referencia_id   uuid references public.prev_sinc(id) on delete set null,
  sinc_referencia_em   timestamptz,
  criada_por           text not null,
  criada_em            timestamptz not null default now(),
  exportada_em         timestamptz,
  envio_confirmado_em  timestamptz,
  cancelada_em         timestamptz,
  observacao           text,
  constraint prev_acao_nome_unico unique (carteira_id, nome)
);

comment on column public.prev_acao.envio_confirmado_em is
  'Marcado à mão pela gestão DEPOIS que a mensageria enviou. Entrega e leitura só entram se a mensageria devolver retorno real — não existe estimativa aqui.';

create table if not exists public.prev_acao_destinatario (
  id            bigserial primary key,
  acao_id       uuid not null references public.prev_acao(id) on delete cascade,
  titulo_id     uuid not null references public.prev_titulo(id) on delete cascade,
  matricula     text not null,
  aluno_nome    text not null,
  contato       text,
  incluido      boolean not null default true,
  motivo        text,
  constraint prev_acao_destinatario_unico unique (acao_id, titulo_id)
);

comment on column public.prev_acao_destinatario.incluido is
  'Falso = separado do público, com o motivo ao lado (sem celular válido, telefone fixo, e-mail inválido, número compartilhado com outro aluno, fora da janela, saldo zerado). Nada é corrigido em silêncio.';

create index if not exists prev_acao_dest_acao_idx on public.prev_acao_destinatario (acao_id, incluido);

-- -----------------------------------------------------------------------------
-- 8. RLS — a trava que vale
-- -----------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array[
    'prev_carteira', 'prev_lote', 'prev_lote_recusa', 'prev_titulo',
    'prev_titulo_lote', 'prev_sinc', 'prev_sinc_fila', 'prev_titulo_snapshot',
    'prev_evento', 'prev_acao', 'prev_acao_destinatario'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);
    execute format('drop policy if exists %I on public.%I', t || '_somente_gestao', t);
    execute format(
      'create policy %I on public.%I for all to authenticated using (public.preventivo_e_gestao()) with check (public.preventivo_e_gestao())',
      t || '_somente_gestao', t);
    -- `anon` nunca chega nestas tabelas, nem para contar linha
    execute format('revoke all on public.%I from anon', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
  end loop;
end
$$;

-- Sequências das tabelas com bigserial: só as do Preventivo. Um
-- `revoke ... on all sequences in schema public` aqui atingiria tabela de
-- outra frente e derrubaria escrita que nada tem a ver com isto.
do $$
declare s text;
begin
  foreach s in array array[
    'prev_lote_recusa_id_seq', 'prev_titulo_snapshot_id_seq',
    'prev_evento_id_seq', 'prev_acao_destinatario_id_seq'
  ] loop
    if exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
               where c.relkind = 'S' and n.nspname = 'public' and c.relname = s) then
      execute format('revoke all on sequence public.%I from anon', s);
      execute format('grant usage, select on sequence public.%I to authenticated', s);
    end if;
  end loop;
end
$$;
