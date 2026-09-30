-- ============================================================================
-- PROPOSTA -- FIDELIZACAO PERTENCE AO RESPONSAVEL ATUAL
--
-- >>> NAO APLICADA. NAO E MIGRATION. <<<
-- Esta pasta (supabase/aguardando_aprovacao/) esta na lista de AUXILIARES da
-- catraca de migrations e NAO e lida pelo `supabase db push`. Para promover,
-- mover para supabase/migrations/ com timestamp proprio -- decisao da gestao.
--
-- Escrita em 29/09/2026. Simulacao que a motivou: somente leitura, em producao.
--
-- ----------------------------------------------------------------------------
-- O PROBLEMA, MEDIDO
--
-- `casos.data_ultimo_acionamento` e do CASO, nao do DONO. Na troca de
-- responsavel ela nao e zerada, e qualquer acionamento de terceiro a renova.
-- Em 29/09/2026, na carteira ativa de 3.518 casos:
--   122 casos carregam data_ultimo_acionamento ANTERIOR a propria atribuicao
--       (relogio herdado do dono anterior);
--   2.484 tiveram acao massiva depois da atribuicao -- e a massiva ja NAO
--       renova (fn_atualizar_ultimo_acionamento a exclui), mas o relogio segue
--       sendo do caso;
--   191 casos nao tinham nenhum acionamento do dono atual.
--
-- A REGRA PROPOSTA
--   fidelizacao_inicio nasce com o dono e so ele a renova.
--   Acionamento de gestao, massiva, rotina, Prime, acordo ou do dono anterior
--   nao renova.
--   Protecoes continuam soberanas: nada aqui as toca.
--
-- O QUE ESTA PROPOSTA *NAO* FAZ
--   nao altera casos_elegiveis_liberacao_fidelizacao() (a v1 segue intacta);
--   nao altera liberar_fidelizacao_caso, liberar_casos_fidelizacao_vencida;
--   nao altera cron nenhum;
--   nao altera caso_protegido_redistribuicao nem qualquer guarda;
--   nao altera eh_tipo_acionamento (usada por nivelamento/cobertura);
--   nao libera, nao redistribui e nao escreve em casos existentes
--     -- o backfill e uma FUNCAO, chamada a mao, nao roda no deploy.
-- ============================================================================

begin;

-- ----------------------------------------------------------------------------
-- 1. PARAMETROS -- fonte central, sem data literal em funcao nenhuma
--
-- Reusa `public.parametros_operacao` (chave/valor jsonb), que ja e o lugar
-- desses ajustes no projeto -- precedente: `prazo_acionamento_base` =
-- {"ate":"2026-09-17"}. Nada de tabela nova.
--
-- modo: 'sombra'  -> v2 so calcula e registra; ninguem e liberado por ela
--       'ativo'   -> v2 passa a valer (troca feita pela gestao, sem deploy)
-- ----------------------------------------------------------------------------
insert into public.parametros_operacao (chave, valor, descricao)
values (
  'fidelizacao_por_dono',
  jsonb_build_object(
    'corte', '2026-10-01',
    'dias', 10,
    'teto_diario_por_operador', 20,
    'modo', 'sombra'
  ),
  'Fidelizacao do responsavel atual. corte = DATA_DE_CORTE (casos anteriores '
  || 'recebem janela nova a partir dela); dias = duracao da fidelizacao; '
  || 'teto_diario_por_operador = maximo de casos soltos por operador por dia; '
  || 'modo = sombra|ativo. Alterar aqui, nunca no corpo das funcoes.'
)
on conflict (chave) do nothing;

create or replace function public.fidelizacao_param()
 returns jsonb language sql stable set search_path to 'public' as $$
  select coalesce(
    (select valor from public.parametros_operacao where chave='fidelizacao_por_dono'),
    -- Padrao defensivo: sem parametro, o modo e SOMBRA. Falta de configuracao
    -- nunca pode virar liberacao de carteira.
    jsonb_build_object('corte', null, 'dias', 10, 'teto_diario_por_operador', 20, 'modo', 'sombra')
  );
$$;

create or replace function public.fidelizacao_corte()
 returns date language sql stable set search_path to 'public' as $$
  select nullif(public.fidelizacao_param() ->> 'corte','')::date;
$$;

-- O CORTE COMO INSTANTE, ANCORADO EM BRASILIA.
--
-- BUG PEGO PELO TESTE B01/B05 EM 29/09/2026, ANTES DE APLICAR: escrever
-- `corte::timestamptz` num banco em UTC produz 2026-10-01 00:00+00, que e
-- 30/09 as 21:00 EM BRASILIA. Como a fronteira le
-- `(inicio at time zone 'America/Sao_Paulo')::date`, o inicio cairia no dia 30/09
-- e o caso ficaria elegivel em 10/10 -- UM DIA ANTES do devido, para os ~3.500
-- casos do backfill de uma vez.
--
-- `corte::timestamp at time zone 'America/Sao_Paulo'` le a meia-noite como hora
-- LOCAL e devolve o instante certo (2026-10-01 03:00+00).
create or replace function public.fidelizacao_corte_ts()
 returns timestamptz language sql stable set search_path to 'public' as $$
  select (public.fidelizacao_corte()::timestamp at time zone 'America/Sao_Paulo');
$$;

create or replace function public.fidelizacao_dias()
 returns int language sql stable set search_path to 'public' as $$
  select coalesce((public.fidelizacao_param() ->> 'dias')::int, 10);
$$;

create or replace function public.fidelizacao_teto_diario()
 returns int language sql stable set search_path to 'public' as $$
  select coalesce((public.fidelizacao_param() ->> 'teto_diario_por_operador')::int, 20);
$$;

create or replace function public.fidelizacao_modo()
 returns text language sql stable set search_path to 'public' as $$
  select coalesce(public.fidelizacao_param() ->> 'modo', 'sombra');
$$;

-- ----------------------------------------------------------------------------
-- 1b. A FRONTEIRA DOS 10 DIAS -- UMA funcao, UM lugar
--
-- REGRA DE NEGOCIO (decisao da gestao, 29/09/2026): "10 dias completos de
-- fidelizacao; no primeiro dia seguinte o caso pode se tornar elegivel".
-- Com inicio em 01/10, os 10 dias completos sao 01/10..10/10 e o primeiro dia
-- elegivel e 11/10. Por isso `<=`, e nao `<`.
--
-- ISTO MUDA O COMPORTAMENTO VIGENTE, DE PROPOSITO. A v1
-- (casos_elegiveis_liberacao_fidelizacao) usa `data_ultimo_acionamento + 10 <
-- current_date`, que com inicio 01/10 so libera em 12/10 -- 11 dias completos,
-- um dia a mais do que a regra escrita. A v1 NAO e alterada; a diferenca fica
-- entre v1 e v2 e aparece na coluna `vigente_tambem` do modo sombra.
--
-- FUSO: data LOCAL DE BRASILIA nos dois lados, nunca `current_date`.
-- O banco roda em UTC (medido: TimeZone=UTC). `current_date` vira o dia
-- seguinte as 21:00 de Brasilia, entao uma execucao entre 21:00 e 23:59 BRT
-- soltaria o caso um dia antes do devido. O cron de hoje roda 08:20 UTC
-- (05:20 BRT) e nao esbarraria nisso -- mas a regra nao pode depender do
-- horario em que alguem resolve rodar. Mesmo cuidado que o front ja toma com
-- `hojeLocalBR()`.
--
-- STABLE, nao IMMUTABLE: depende de now().
-- ----------------------------------------------------------------------------
create or replace function public.hoje_brt()
 returns date language sql stable set search_path to 'public' as $$
  select (now() at time zone 'America/Sao_Paulo')::date;
$$;

create or replace function public.fidelizacao_vencida(p_inicio timestamptz)
 returns boolean language sql stable set search_path to 'public' as $$
  select p_inicio is not null
     and ((p_inicio at time zone 'America/Sao_Paulo')::date + public.fidelizacao_dias())
         <= public.hoje_brt();
$$;

-- LIMITE SARGAVEL -- a MESMA fronteira, escrita de um jeito que o planner
-- consegue usar como faixa sobre a coluna.
--
-- PROBLEMA MEDIDO (teste de performance, 29/09/2026, 3.500 casos): com o
-- predicado escrito como `public.fidelizacao_vencida(c.fidelizacao_inicio)`, o
-- plano era `Seq Scan on casos` com `Filter: fidelizacao_vencida(...)` --
-- chamada de funcao por linha, e o indice parcial idx_casos_fidelizacao_inicio
-- IGNORADO. Funcao sobre a coluna e opaca para o planner, por mais STABLE que
-- seja. Em 3.500 linhas isso e irrelevante; nos 18.424 casos de producao, com
-- so uma fracao vencida, deixa de ser.
--
-- EQUIVALENCIA ALGEBRICA (o teste de comportamento prova que os dois conjuntos
-- sao identicos):
--     (inicio AT TZ BRT)::date + dias <= hoje_brt()
--  <=> (inicio AT TZ BRT)::date      <= hoje_brt() - dias
--  <=>  inicio                        <  meia-noite BRT de (hoje_brt() - dias + 1)
--
-- `fidelizacao_vencida` continua existindo e continua sendo a definicao legivel
-- da regra -- e o que se le para entender e auditar. A v2 usa o limite por
-- performance, e o teste garante que nunca divergem.
create or replace function public.fidelizacao_limite_vencido()
 returns timestamptz language sql stable set search_path to 'public' as $$
  select ((public.hoje_brt() - public.fidelizacao_dias() + 1)::timestamp
          at time zone 'America/Sao_Paulo');
$$;

-- Data em que o caso PODE virar elegivel -- so para exibir e auditar.
create or replace function public.fidelizacao_elegivel_em(p_inicio timestamptz)
 returns date language sql stable set search_path to 'public' as $$
  select (p_inicio at time zone 'America/Sao_Paulo')::date + public.fidelizacao_dias();
$$;

-- ----------------------------------------------------------------------------
-- 1c. TRES DEFINICOES DE FIDELIZACAO CONVIVEM EM PRODUCAO HOJE.
--     NAO SERAO HARMONIZADAS NESTE PR (decisao da gestao, 29/09/2026).
--
-- Levantado no catalogo de producao em 29/09/2026:
--
--   1. public.casos_elegiveis_liberacao_fidelizacao  (a v1, que o cron usa)
--        casos.data_ultimo_acionamento + 10 < current_date
--        relogio do CASO, data em UTC  ->  com inicio 01/10, libera em 12/10
--
--   2. public.caso_dentro_prazo_fidelizacao(date)
--        p_data_ultimo_acionamento + 10 >= current_date
--        relogio do CASO, data em UTC  ->  complemento coerente da v1
--
--   3. internal.matricula_em_fidelizacao(uuid, text)   <-- usada pelo
--      trigger_impor_teto_operador
--        alunos.responsavel_atual_em > now() - interval '10 days'
--        relogio do DONO, por TIMESTAMP, sensivel a hora do dia
--
-- A terceira JA conta da atribuicao ao dono atual -- o mesmo conceito desta
-- proposta -- e nenhuma das tres usa data local de Brasilia. Com a v2 entram
-- QUATRO definicoes no banco.
--
-- ESTA PROPOSTA NAO TOCA EM 1, 2 NEM 3. Harmonizar mexeria no receptivo e no
-- teto de 500, que estao fora de escopo. A divergencia fica registrada aqui, no
-- PR e num teste de nao regressao que falha se alguem alterar 2 ou 3 sem
-- decisao (supabase/tests/fidelizacao_por_dono_comportamento.test.js).

-- ----------------------------------------------------------------------------
-- 2. O QUE RENOVA -- predicado proprio, com os 7 tipos aprovados
--
-- POR QUE NAO REUSAR `eh_tipo_acionamento`: a lista dela e OUTRA. Ela tem
-- FINALIZACAO, CONTATO, SOLICITACAO_LINK_PAGAMENTO, TERMO_ENVIADO_ADM,
-- RETORNO_ADM_CRIADO e RETORNO_ADM_CONCLUIDO -- todos reprovados para
-- fidelizacao -- e NAO tem EM_ATENDIMENTO, RETORNO_TERMO nem BAIXA_REALIZADA,
-- que foram aprovados. Sao 8 divergencias. Reusar aquela funcao mudaria a
-- regra aprovada em silencio, e mexer nela quebraria nivelamento e cobertura,
-- que dependem da lista larga. Duas perguntas diferentes, dois predicados.
-- ----------------------------------------------------------------------------
-- OS TRES TIPOS AMPLIADOS -- EM_ATENDIMENTO, RETORNO_TERMO e BAIXA_REALIZADA
-- NAO estao em `eh_tipo_acionamento`, logo hoje NAO atualizam
-- `casos.data_ultimo_acionamento`. Na regra nova eles RENOVAM
-- `fidelizacao_inicio`. Isto e intencional (decisao da gestao, 29/09/2026):
-- sao trabalho individual do dono sobre o caso.
--
-- E a semantica antiga NAO muda por causa disso: o bloco que grava
-- `data_ultimo_acionamento` em fn_atualizar_ultimo_acionamento continua atras
-- do mesmo `if not public.eh_tipo_acionamento(new.tipo) then return new; end if;`
-- de hoje, com a mesma lista. Um EM_ATENDIMENTO sequer entra na funcao, e
-- portanto continua sem tocar data_ultimo_acionamento -- exatamente como antes.
-- Ver o bloco <<NOVO>> na secao 6: ele e a UNICA escrita nova, e escreve so em
-- fidelizacao_inicio.
--
-- E o caminho inverso tambem vale: a fidelizacao nova NAO LE
-- data_ultimo_acionamento em lugar nenhum -- nem na v2, nem no backfill, nem na
-- sombra. As duas grandezas passam a ser independentes.
create or replace function public.eh_acionamento_fidelizacao(p_tipo text)
 returns boolean language sql immutable set search_path to 'public' as $$
  select coalesce(p_tipo,'') in (
    'FINALIZACAO_ATENDIMENTO',
    'EM_ATENDIMENTO',
    'LINK_ENVIADO_AO_ALUNO',
    'COMPROVANTE_ENVIADO_BAIXA',
    'RETORNO_TERMO',
    'BAIXA_REALIZADA',
    'QUITADO_MANUAL'
  );
$$;

-- ----------------------------------------------------------------------------
-- 3. A COLUNA
--
-- Aditiva e anulavel. `null` = ainda nao inicializado: a v2 IGNORA esses casos,
-- entao ligar a coluna antes do backfill nao solta ninguem.
-- ----------------------------------------------------------------------------
alter table public.casos add column if not exists fidelizacao_inicio timestamptz;

-- `comment on ... is` aceita SO literal -- concatenacao com || e erro de
-- sintaxe. Pego pelo teste de fixture em 29/09/2026, antes de aplicar.
comment on column public.casos.fidelizacao_inicio is
  'Inicio da fidelizacao DO RESPONSAVEL ATUAL. Nasce na troca de dono e so e renovado por acionamento individual do proprio dono (eh_acionamento_fidelizacao). null = nao inicializado; a regra v2 ignora. NAO derivar de data_ultimo_acionamento, que e do caso e nao do dono.';

-- Indice parcial: a v2 varre so o que tem relogio e nao esta encerrado.
create index if not exists idx_casos_fidelizacao_inicio
  on public.casos (fidelizacao_inicio)
  where fidelizacao_inicio is not null and encerrado_operacional = false;

-- ----------------------------------------------------------------------------
-- 4. INICIALIZACAO PELO CORTE -- funcao, NAO roda no deploy
--
-- Para caso atribuido ANTES do corte: fidelizacao_inicio = corte (janela nova
-- completa, o passado nao e reinterpretado -- nada e derivado de
-- data_ultimo_acionamento).
-- Para caso atribuido A PARTIR do corte: fidelizacao_inicio = atribuicao real.
--
-- Idempotente: so escreve onde ainda esta nulo. Rodar duas vezes nao muda nada.
-- ----------------------------------------------------------------------------
create or replace function public.fidelizacao_backfill_corte()
 returns integer language plpgsql security definer set search_path to 'public' as $$
declare v_corte date; v_corte_ts timestamptz; v_n int;
begin
  if not public.usuario_e_gestao_fila() then
    raise exception 'sem_permissao' using errcode='42501';
  end if;
  v_corte := public.fidelizacao_corte();
  if v_corte is null then
    raise exception 'DATA_DE_CORTE nao configurada em parametros_operacao.fidelizacao_por_dono';
  end if;
  -- meia-noite do corte NO FUSO DE BRASILIA -- ver fidelizacao_corte_ts()
  v_corte_ts := public.fidelizacao_corte_ts();

  -- greatest(atribuicao, corte) da exatamente as duas regras pedidas:
  --   atribuido ANTES do corte  -> corte        (janela nova completa)
  --   atribuido DEPOIS do corte -> atribuicao   (relogio real do dono)
  -- E o `greatest` com o valor atual garante que o backfill NUNCA REDUZ um
  -- fidelizacao_inicio ja existente -- se a renovacao do dono ja o empurrou
  -- para frente, o backfill nao o joga de volta para o corte.
  update public.casos c
     set fidelizacao_inicio = greatest(
           c.fidelizacao_inicio,
           coalesce(a.responsavel_atual_em, v_corte_ts),
           v_corte_ts)
    from public.alunos a
   where a.id = c.aluno_id
     and c.operador_email is not null
     and c.encerrado_operacional = false
     -- IDEMPOTENTE: so escreve quando ha de fato o que mudar. Segunda execucao
     -- no mesmo dia nao toca linha nenhuma e devolve 0.
     and (c.fidelizacao_inicio is null
          or c.fidelizacao_inicio < greatest(
               coalesce(a.responsavel_atual_em, v_corte_ts),
               v_corte_ts));
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- ----------------------------------------------------------------------------
-- 4b. O QUE JA EXISTE EM PRODUCAO NA TROCA DE DONO -- lido do catalogo em
--     29/09/2026, e por que a coluna nova ainda e necessaria.
--
-- `public.casos` tem `trg_sync_alunos_apos_casos` AFTER UPDATE ... WHEN
-- (new.operador_email IS DISTINCT FROM old.operador_email), que chama
-- `internal.set_resp_aluno`. Essa funcao JA faz, na troca de dono:
--     alunos.responsavel_atual_em      := now()
--     alunos.data_ultimo_acionamento   := null   (quando o dono muda de fato)
--     alunos.status_acionamento/proxima_acao/data_retorno := null
-- e registra REDISTRIBUICAO_SINCRONIZACAO em aluno_movimentacoes.
--
-- ISTO CONFIRMA O DIAGNOSTICO PELO CODIGO, nao so pelos dados: o relogio JA
-- reinicia na troca de dono -- mas SO em `alunos`. `casos.data_ultimo_acionamento`
-- NAO e zerado por ninguem nessa cadeia, e e ele que a v1 usa para decidir
-- liberacao. E exatamente a origem dos 122 casos medidos com relogio anterior
-- a propria atribuicao.
--
-- Poderiamos entao usar `alunos.responsavel_atual_em` e dispensar a coluna? Nao:
--   (a) ele e sobrescrito por QUALQUER troca de responsavel do ALUNO, inclusive
--       as vindas de acordo, e nao guarda renovacao por acionamento;
--   (b) a unidade da fidelizacao e o CASO, e um aluno pode ter mais de um caso;
--   (c) `set_resp_aluno` so roda quando `NEW.aluno_id is not null`.
-- A coluna em `casos` e o unico lugar onde "relogio do dono DESTE caso" cabe.
--
-- NOTA DE CADEIA DE GATILHOS: aquele insert de REDISTRIBUICAO_SINCRONIZACAO
-- dispara `trg_atualizar_ultimo_acionamento`. O tipo nao esta em
-- `eh_tipo_acionamento` nem em `eh_acionamento_fidelizacao`, entao a funcao
-- retorna na primeira linha e nao ha reentrada. Verificado no catalogo.

-- ----------------------------------------------------------------------------
-- 5. TROCA DE DONO -- relogio nasce com quem recebeu
--
-- Trigger BEFORE UPDATE com clausula WHEN: so dispara quando operador_email
-- muda de verdade. Em 29/09/2026 foram 1.068 movimentacoes de ALTERACAO_OPERADOR
-- em tres meses -- ordem de dezenas por dia. Custo irrelevante, e zero em todo
-- UPDATE que nao troca o dono (a clausula WHEN e avaliada antes da funcao).
--
-- Recursao: a funcao NAO faz UPDATE; so escreve em NEW, no BEFORE. Nao ha como
-- reentrar. Nao interage com trigger_impor_teto_operador nem com
-- trigger_repor_caso_operador, que sao AFTER e mexem em outras linhas.
-- ----------------------------------------------------------------------------
create or replace function public._fidelizacao_nasce_com_o_dono()
 returns trigger language plpgsql set search_path to 'public' as $$
begin
  if new.operador_email is null then
    -- Caso liberado para a fila: sem dono, sem relogio.
    new.fidelizacao_inicio := null;
  else
    new.fidelizacao_inicio := now();
  end if;
  return new;
end;
$$;

drop trigger if exists trg_fidelizacao_nasce_com_o_dono on public.casos;
create trigger trg_fidelizacao_nasce_com_o_dono
  before update on public.casos
  for each row
  when (old.operador_email is distinct from new.operador_email)
  execute function public._fidelizacao_nasce_com_o_dono();

-- ----------------------------------------------------------------------------
-- 6. RENOVACAO -- dentro do gatilho que JA existe
--
-- POR QUE AQUI, e nao num trigger novo nem nas telas: nao existe ponto central
-- de gravacao no aplicativo -- `FINALIZACAO_ATENDIMENTO` e inserido
-- diretamente em SETE lugares do front (EnvioFinanceiro, PainelCarteira x3,
-- Aluno, FilaOperacional, ConfirmarPagamento). Corrigir tela por tela deixaria
-- de fora a oitava que aparecer. `trg_atualizar_ultimo_acionamento` ja e o
-- ponto unico por onde todo acionamento passa, ja filtra tipo, ja exclui acao
-- massiva e ja atualiza casos.data_ultimo_acionamento.
--
-- Volume medido em 29/09/2026: 1.569 inserts em 24 h, 9.949 em 7 dias, dos
-- quais 4.148 dos 7 tipos. Sao dezenas por minuto no pico -- o UPDATE extra e
-- uma linha por insert, pela PK.
--
-- Recursao: escreve em `casos`, nunca em `aluno_movimentacoes`. O UPDATE em
-- casos NAO dispara trg_fidelizacao_nasce_com_o_dono, porque a clausula WHEN
-- exige troca de operador_email, que este UPDATE nao faz.
--
-- Concorrencia: o UPDATE e por (aluno_id) com guarda de monotonicidade
-- (`is null or < novo`), entao dois acionamentos simultaneos do mesmo aluno
-- convergem para o mais recente, em qualquer ordem de chegada. Nao ha
-- SELECT-then-UPDATE.
--
-- O acrescimo a funcao existente sao as DUAS clausulas marcadas <<NOVO>>.
-- Todo o resto e identico ao que esta em producao hoje.
-- ----------------------------------------------------------------------------
create or replace function public.fn_atualizar_ultimo_acionamento()
 returns trigger language plpgsql security definer set search_path to 'public' as $$
declare v_uuid uuid;
begin
  -- PORTAO DE ENTRADA. Precisa aceitar a UNIAO das duas listas: a antiga
  -- (eh_tipo_acionamento, que manda em data_ultimo_acionamento) e a nova
  -- (eh_acionamento_fidelizacao, que manda em fidelizacao_inicio). Sem a
  -- segunda, EM_ATENDIMENTO / RETORNO_TERMO / BAIXA_REALIZADA sairiam aqui e
  -- nunca renovariam a fidelizacao. Cada bloco abaixo continua com o seu
  -- proprio filtro, entao nenhum tipo passa a fazer o que nao fazia.
  if not public.eh_tipo_acionamento(new.tipo)
     and not public.eh_acionamento_fidelizacao(new.tipo) then
    return new;
  end if;

  -- Acao massiva confirmada e ATIVIDADE (fica registrada e visivel), mas NAO e
  -- contato operacional: nao renova fidelizacao, nao mexe no nivelamento nem na
  -- liberacao. A cobertura le a movimentacao diretamente.
  if new.tipo in ('ACAO_MASSIVA_EXTERNA', 'ACAO_MASSIVA_EXTERNA_EMAIL') then
    return new;
  end if;

  begin
    v_uuid := new.aluno_id::uuid;
  exception when others then
    return new;
  end;

  -- SEMANTICA ANTIGA, INTACTA: so a lista antiga escreve em
  -- data_ultimo_acionamento. Os tres tipos ampliados nao entram aqui.
  if public.eh_tipo_acionamento(new.tipo) then
  update public.alunos a
     set data_ultimo_acionamento = new.registrado_em
   where a.id = v_uuid
     and (a.data_ultimo_acionamento is null
          or a.data_ultimo_acionamento < new.registrado_em);
  end if;

  -- UM UNICO UPDATE EM public.casos, PARA AS DUAS COLUNAS.
  --
  -- BUG PEGO NA ANALISE DE DEPENDENCIAS EM 29/09/2026, ANTES DE APLICAR: a
  -- primeira versao desta proposta fazia DOIS `update public.casos` na mesma
  -- funcao -- um para data_ultimo_acionamento, outro para fidelizacao_inicio.
  -- `public.casos` tem `trigger_repor_caso_operador` AFTER UPDATE ... WHEN
  -- (new.operador_email = old.operador_email), que ao encontrar caso fechado
  -- LIBERA o caso (zera o operador), grava LIBERACAO_AUTOMATICA_CASO_FECHADO em
  -- historico_operadores_alunos e enfileira em reposicao_carteira_fila. Dois
  -- UPDATEs = esse gatilho avaliado DUAS vezes por acionamento, contra uma vez
  -- hoje. Alem de dobrar trabalho, muda o estado observado pelo segundo UPDATE
  -- (o primeiro pode ter zerado operador_email), o que torna o resultado
  -- dependente de ordem -- exatamente o que nao se quer numa regra de posse.
  --
  -- Com um UPDATE so, a contagem de disparos fica IDENTICA a de hoje. Cada
  -- coluna tem sua propria condicao no CASE, entao nenhuma passa a andar em
  -- situacao onde nao andava. O WHERE final evita UPDATE no-op -- que tambem
  -- dispararia os gatilhos sem necessidade.
  update public.casos c
     set data_ultimo_acionamento = case
           when public.eh_tipo_acionamento(new.tipo)
            and (c.data_ultimo_acionamento is null
                 or c.data_ultimo_acionamento < new.registrado_em::date)
           then new.registrado_em::date
           else c.data_ultimo_acionamento end,
         -- <<NOVO>> RENOVACAO DA FIDELIZACAO DO DONO.
         -- Tres condicoes, todas obrigatorias:
         --   tipo na lista aprovada dos 7 (nao a lista larga de eh_tipo_acionamento);
         --   o autor da movimentacao E o responsavel atual do caso;
         --   o acionamento e posterior ao inicio vigente (nunca anda para tras).
         -- Gestao, rotina, Prime, acordo e dono anterior nao passam por aqui.
         -- `fidelizacao_inicio is not null` mantem o freio: caso nao
         -- inicializado pelo backfill nao entra na regra nova.
         fidelizacao_inicio = case
           when public.eh_acionamento_fidelizacao(new.tipo)
            and new.registrado_por_email is not null
            and c.encerrado_operacional = false
            and c.fidelizacao_inicio is not null
            and lower(c.operador_email) = lower(new.registrado_por_email)
            and c.fidelizacao_inicio < new.registrado_em
           then new.registrado_em
           else c.fidelizacao_inicio end
   where c.aluno_id = v_uuid
     and (
       -- data_ultimo_acionamento avancaria
       (public.eh_tipo_acionamento(new.tipo)
        and (c.data_ultimo_acionamento is null
             or c.data_ultimo_acionamento < new.registrado_em::date))
       or
       -- fidelizacao_inicio avancaria
       (public.eh_acionamento_fidelizacao(new.tipo)
        and new.registrado_por_email is not null
        and c.encerrado_operacional = false
        and c.fidelizacao_inicio is not null
        and lower(c.operador_email) = lower(new.registrado_por_email)
        and c.fidelizacao_inicio < new.registrado_em)
     );

  -- recalcular situacao/criticidade apos o acionamento (dias_sem_acionamento zera).
  -- protegido: falha aqui nunca impede o registro do acionamento.
  begin
    perform public.recalcular_situacao_aluno(v_uuid, 'acionamento');
  exception when others then
    null;
  end;

  return new;
exception when others then
  -- nunca impedir o registro do acionamento por falha na atualizacao da ficha
  return new;
end;
$$;

-- ----------------------------------------------------------------------------
-- 7. ELEGIBILIDADE v2 -- funcao NOVA, a v1 nao e tocada
--
-- FRONTEIRA: uma unica funcao, public.fidelizacao_vencida (secao 1b). Regra
-- literal da gestao -- 10 dias completos, elegivel no primeiro dia seguinte --
-- em data local de Brasilia. Inicio 01/10 => elegivel em 11/10.
--
-- `fidelizacao_inicio is not null` e o freio de mao: caso nao inicializado
-- nunca e elegivel, entao aplicar isto antes do backfill nao solta ninguem.
-- ----------------------------------------------------------------------------
create or replace function public.casos_elegiveis_liberacao_fidelizacao_v2()
 returns table(
   caso_id uuid, aluno_id uuid, operador_email text, operador_nome text,
   fidelizacao_inicio timestamptz, fidelizado_ate date, saldo numeric,
   protegido boolean, ordem_na_fila bigint)
 language sql stable security definer set search_path to 'public' as $$
  with cand as (
    select c.id, c.aluno_id, c.operador_email, c.operador_nome, c.fidelizacao_inicio,
           public.fidelizacao_elegivel_em(c.fidelizacao_inicio) as fidelizado_ate,
           public.saldo_titulos_aberto(c.cpf_limpo) as saldo,
           a.responsavel_atual_em,
           public.caso_protegido_redistribuicao(c.cpf_limpo, c.status_acionamento,
             c.nao_acionar, c.status_financeiro, c.valor_pago, c.quitado_em, c.valor_quitado)
             as protegido
      from public.casos c
      join public.alunos a on a.id = c.aluno_id
     where c.operador_email is not null
       and lower(c.operador_email) <> internal.carteira_geral_email()
       and c.encerrado_operacional = false
       and c.fidelizacao_inicio is not null
       -- fronteira em forma de FAIXA, para o indice parcial ser usado; e a mesma
       -- regra de public.fidelizacao_vencida (ver a equivalencia na secao 1b)
       and c.fidelizacao_inicio < public.fidelizacao_limite_vencido()
       and not public.caso_encerrado_operacional(c.cpf_limpo, c.status_atual,
             c.status_acionamento, c.status_financeiro, c.status_jornada)
  )
  select id, aluno_id, operador_email, operador_nome, fidelizacao_inicio,
         fidelizado_ate, saldo, protegido,
         -- ORDEM DETERMINISTICA DE SAIDA, para o teto diario. Tres niveis:
         --
         -- 1) fidelizacao_inicio asc -- "maior tempo sem acionamento valido".
         --    Depois da transicao os dois viram a MESMA coisa: a renovacao
         --    grava o acionamento do dono em fidelizacao_inicio, entao o
         --    campo JA E o ultimo acionamento valido. Nao precisa de
         --    subconsulta em aluno_movimentacoes na hora de soltar.
         -- 2) responsavel_atual_em asc -- "mais antigo na atribuicao".
         --    Existe por causa do DIA 1: no corte, todo caso anterior recebe
         --    fidelizacao_inicio = DATA_DE_CORTE e o nivel 1 empata em massa
         --    (em 29/09/2026 seriam 1.380 casos no mesmo instante). Quem esta
         --    com o operador ha mais tempo sai primeiro.
         -- 3) id asc -- desempate final, estavel entre execucoes.
         --
         -- Valor financeiro NAO entra na prioridade (nao autorizado).
         row_number() over (partition by operador_email
                            order by fidelizacao_inicio asc,
                                     responsavel_atual_em asc nulls first,
                                     id asc)
      from cand
     -- PROTEGIDO NAO CONSOME VAGA DO TETO: em SQL o WHERE e avaliado ANTES das
     -- funcoes de janela, entao o row_number numera apenas os desprotegidos.
     -- Com 25 vencidos e os 5 primeiros protegidos, as posicoes 1..20 saem dos
     -- 20 desprotegidos -- o operador solta 20, nao 15.
     where not protegido;
$$;

-- ----------------------------------------------------------------------------
-- 8. MODO SOMBRA -- registra o que a v2 FARIA, sem liberar nada
--
-- IDEMPOTENCIA: PK (dia, caso_id) -- uma linha por caso por dia. Reexecucao no
-- mesmo dia ATUALIZA a linha (o estado pode ter mudado de manha para a tarde),
-- nunca duplica. Comparacao com a regra vigente sai de `vigente_tambem`.
-- ----------------------------------------------------------------------------
create table if not exists public.fidelizacao_sombra (
  -- DATA LOCAL DE BRASILIA, nunca current_date: com o banco em UTC, uma
  -- execucao entre 21:00 e 23:59 BRT gravaria a sombra no dia seguinte e
  -- estragaria a comparacao dia a dia.
  dia                    date        not null default public.hoje_brt(),
  caso_id                uuid        not null,
  aluno_id               uuid,
  operador_email         text,
  operador_nome          text,
  fidelizacao_inicio     timestamptz,
  ultimo_acion_do_dono   timestamptz,
  fidelizado_ate         date,
  motivo                 text,
  protecao_encontrada    text,
  saldo                  numeric,
  ordem_na_fila          bigint,
  dentro_do_teto         boolean,
  vigente_tambem         boolean,
  simulado_em            timestamptz not null default now(),
  primary key (dia, caso_id)
);

comment on table public.fidelizacao_sombra is
  'Modo sombra da fidelizacao por dono: o que a v2 teria liberado. Uma linha por caso por dia (PK dia+caso_id). Nao libera nada.';

create or replace function public.fidelizacao_sombra_registrar()
 returns integer language plpgsql security definer set search_path to 'public' as $$
declare v_n int; v_teto int := public.fidelizacao_teto_diario();
begin
  if not public.usuario_e_gestao_fila() then
    raise exception 'sem_permissao' using errcode='42501';
  end if;

  with vigente as (select f.caso_id from public.casos_elegiveis_liberacao_fidelizacao() f),
  candidatos as (
    select c.id caso_id, c.aluno_id, c.operador_email, c.operador_nome, c.fidelizacao_inicio,
           public.fidelizacao_elegivel_em(c.fidelizacao_inicio) fidelizado_ate,
           public.saldo_titulos_aberto(c.cpf_limpo) saldo,
           a.responsavel_atual_em,
           public.caso_protegido_redistribuicao(c.cpf_limpo, c.status_acionamento,
             c.nao_acionar, c.status_financeiro, c.valor_pago, c.quitado_em, c.valor_quitado) protegido,
           (select max(m.registrado_em) from public.aluno_movimentacoes m
             where m.aluno_id = c.aluno_id::text
               and lower(coalesce(m.registrado_por_email,'')) = lower(c.operador_email)
               and public.eh_acionamento_fidelizacao(m.tipo)
               and m.registrado_em >= c.fidelizacao_inicio) ultimo_acion_do_dono
      from public.casos c
      join public.alunos a on a.id = c.aluno_id
     where c.operador_email is not null
       and lower(c.operador_email) <> internal.carteira_geral_email()
       and c.encerrado_operacional = false
       and c.fidelizacao_inicio is not null
       and c.fidelizacao_inicio < public.fidelizacao_limite_vencido()
  ),
  -- PROTEGIDO NAO CONSOME VAGA DO TETO. A numeracao roda SO sobre os
  -- desprotegidos -- igual a v2, onde o `where not protegido` e avaliado antes
  -- da funcao de janela. Se 5 dos 25 primeiros estao protegidos, o operador
  -- ainda solta 20 desprotegidos, e nao 15. O caso protegido continua
  -- registrado na sombra, com pos nula e a protecao nomeada.
  ordenado as (
    select k.*,
      case when k.protegido then null
           else row_number() over (partition by k.operador_email
                                   order by k.fidelizacao_inicio asc,
                                            k.responsavel_atual_em asc nulls first,
                                            k.caso_id asc) end pos
    from candidatos k
    where not k.protegido
    union all
    select k.*, null::bigint pos from candidatos k where k.protegido
  )
  insert into public.fidelizacao_sombra as s (
    dia, caso_id, aluno_id, operador_email, operador_nome, fidelizacao_inicio,
    ultimo_acion_do_dono, fidelizado_ate, motivo, protecao_encontrada, saldo,
    ordem_na_fila, dentro_do_teto, vigente_tambem, simulado_em)
  select public.hoje_brt(), o.caso_id, o.aluno_id, o.operador_email, o.operador_nome,
         o.fidelizacao_inicio, o.ultimo_acion_do_dono, o.fidelizado_ate,
         case when o.ultimo_acion_do_dono is null
                then 'sem acionamento do dono desde ' || o.fidelizacao_inicio::date
              else 'ultimo acionamento do dono em ' || o.ultimo_acion_do_dono::date
                   || ', fidelizacao venceu em ' || o.fidelizado_ate end,
         case when o.protegido then 'caso_protegido_redistribuicao' else null end,
         o.saldo, o.pos,
         (o.pos is not null and o.pos <= v_teto),
         exists (select 1 from vigente v where v.caso_id = o.caso_id),
         now()
    from ordenado o
  on conflict (dia, caso_id) do update set
     fidelizacao_inicio   = excluded.fidelizacao_inicio,
     ultimo_acion_do_dono = excluded.ultimo_acion_do_dono,
     fidelizado_ate       = excluded.fidelizado_ate,
     motivo               = excluded.motivo,
     protecao_encontrada  = excluded.protecao_encontrada,
     saldo                = excluded.saldo,
     ordem_na_fila        = excluded.ordem_na_fila,
     dentro_do_teto       = excluded.dentro_do_teto,
     vigente_tambem       = excluded.vigente_tambem,
     simulado_em          = excluded.simulado_em;

  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- ----------------------------------------------------------------------------
-- 8b. COMO O TETO E APLICADO
--
-- A v2 devolve `ordem_na_fila` JA PARTICIONADA POR OPERADOR
-- (`partition by operador_email`). Quem for soltar filtra
-- `ordem_na_fila <= public.fidelizacao_teto_diario()` -- valor que vem da
-- configuracao, nunca literal. Por ser particionado, o teto e POR OPERADOR e
-- nunca global: com 35 elegiveis no operador A e 8 no B, teto 20 solta 20 de A
-- e 8 de B (28 no total) e os 15 restantes de A ficam para o dia seguinte.
--
-- A funcao de liberacao em si NAO faz parte desta proposta -- entra no passo 4
-- da ativacao, depois da sombra aprovada.

-- ----------------------------------------------------------------------------
-- 9. PERMISSOES -- mesmo padrao das funcoes de fila: anon nunca executa
-- ----------------------------------------------------------------------------
revoke all on function public.fidelizacao_backfill_corte() from public, anon;
revoke all on function public.fidelizacao_sombra_registrar() from public, anon;
revoke all on function public.casos_elegiveis_liberacao_fidelizacao_v2() from public, anon;
revoke all on function public.fidelizacao_vencida(timestamptz) from public, anon;
revoke all on function public.fidelizacao_elegivel_em(timestamptz) from public, anon;
revoke all on function public.fidelizacao_limite_vencido() from public, anon;
revoke all on function public.hoje_brt() from public, anon;
revoke all on function public.fidelizacao_corte_ts() from public, anon;
grant execute on function public.fidelizacao_backfill_corte() to authenticated;
grant execute on function public.fidelizacao_sombra_registrar() to authenticated;
grant execute on function public.casos_elegiveis_liberacao_fidelizacao_v2() to authenticated;
grant execute on function public.fidelizacao_vencida(timestamptz) to authenticated;
grant execute on function public.fidelizacao_elegivel_em(timestamptz) to authenticated;
grant execute on function public.fidelizacao_limite_vencido() to authenticated;
grant execute on function public.hoje_brt() to authenticated;
grant execute on function public.fidelizacao_corte_ts() to authenticated;

alter table public.fidelizacao_sombra enable row level security;
drop policy if exists fidelizacao_sombra_leitura_gestao on public.fidelizacao_sombra;
create policy fidelizacao_sombra_leitura_gestao on public.fidelizacao_sombra
  for select to authenticated using (public.usuario_e_gestao_fila());

commit;

-- ============================================================================
-- ORDEM DE ATIVACAO (cada passo e uma decisao, nenhum e automatico)
--
--   1. aplicar este arquivo -> nada muda: fidelizacao_inicio nasce nulo e a v2
--      ignora nulo. O cron continua na v1.
--   2. no dia do corte:  select public.fidelizacao_backfill_corte();
--   3. por NO MINIMO 3 DIAS UTEIS COMPLETOS, uma vez por dia:
--                        select public.fidelizacao_sombra_registrar();
--      comparar:  select dia, count(*) filter (where protecao_encontrada is null) eleg_v2,
--                        count(*) filter (where vigente_tambem) eleg_v1,
--                        count(*) filter (where dentro_do_teto) sairia_hoje
--                   from public.fidelizacao_sombra group by 1 order by 1;
--   4. so entao, se a gestao aprovar: trocar modo para 'ativo' em
--      parametros_operacao e apontar o cron para a v2. NAO faz parte deste
--      arquivo -- de proposito.
--
-- ROLLBACK (por passo, do mais leve ao mais pesado)
--   a) parar a sombra: nao chamar mais fidelizacao_sombra_registrar().
--   b) voltar o cron para casos_elegiveis_liberacao_fidelizacao() -- a v1 nunca
--      foi alterada, entao isto e so reapontar.
--   c) desligar a renovacao: restaurar fn_atualizar_ultimo_acionamento sem o
--      bloco <<NOVO>> (o corpo original esta acima, palavra por palavra).
--   d) drop trigger trg_fidelizacao_nasce_com_o_dono on public.casos;
--   e) ORDEM IMPORTA -- a tabela da sombra usa hoje_brt() no default da coluna
--      `dia`, entao ela sai ANTES da funcao (erro pego pelo teste X do arquivo
--      supabase/tests/fidelizacao_por_dono_comportamento.test.js, em
--      29/09/2026: "cannot drop function hoje_brt() because other objects
--      depend on it"). Sequencia que funciona:
--        drop table fidelizacao_sombra;
--        drop function casos_elegiveis_liberacao_fidelizacao_v2,
--          fidelizacao_sombra_registrar, fidelizacao_backfill_corte,
--          fidelizacao_vencida, fidelizacao_elegivel_em, fidelizacao_corte_ts,
--          fidelizacao_param, fidelizacao_corte, fidelizacao_dias,
--          fidelizacao_teto_diario, fidelizacao_modo, fidelizacao_limite_vencido,
--          hoje_brt,
--          eh_acionamento_fidelizacao;
--   f) alter table casos drop column fidelizacao_inicio;  -- ultimo recurso
--
-- Nada e sobrescrito: data_ultimo_acionamento, alunos.responsavel_atual_em e o
-- historico ficam intactos. O rollback e reversivel em qualquer ponto.
-- ============================================================================
