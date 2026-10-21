-- ASSUMIR ATENDIMENTO: teto oficial e as tres carteiras de livre assuncao.
--
-- Regra permanente de distribuicao, artigos 2 e 5 (gestao, 20/10/2026).
--
-- DOIS DEFEITOS MEDIDOS EM PRODUCAO EM 20/10/2026
--
-- 1) O TETO DENTRO DA FUNCAO E 500, E A BASE DE CONTAGEM E OUTRA.
--    `assumir_caso_livre` conta `casos` do operador menos os que aguardam
--    confirmacao financeira -- em 20/10 isso dava de 964 a 1.031 casos por
--    operador. O teto oficial e 700 (`calibragem_teto_operador`, parametro
--    `limite_carteira`) e e cobrado sobre OUTRA base: casos nao protegidos e
--    nao encerrados, que no mesmo dia dava de 555 a 618. Ou seja: a funcao
--    comparava ~1.000 contra 500 e caia sempre no ramo de troca; no fim, a
--    guarda `> 500` estourava `raise exception` e desfazia tudo.
--    EFEITO: "Assumir atendimento" falhava para TODOS os sete operadores.
--    Trocar 500 por 700 nao resolveria -- ~1.000 > 700 tambem. O que resolve e
--    contar a MESMA coisa que o teto cobra.
--
-- 2) AS TRES CARTEIRAS NAO ERAM ASSUMIVEIS.
--    A funcao recusa caso que tenha dono quando `giro_fidelizacao_ate` e nulo,
--    com "Este caso ja foi assumido por outro operador". A Carteira Geral
--    (`internal.carteira_geral_email()`), a carteira da gestao e a antiga
--    carteira da Olga tem dono e nao tem marca de giro -- conferido em 20/10:
--    371 + 118 + 106 = 595 casos, ZERO com marca. Logo nenhum deles podia ser
--    assumido, e o artigo 2 era tecnicamente impossivel.
--
-- O QUE NAO MUDA
--
--  * As guardas de elegibilidade. `caso_protegido_redistribuicao` e
--    `caso_encerrado_operacional` continuam sendo chamadas no mesmo ponto, com
--    os mesmos argumentos, e o `saldo > 0` continua exigido -- `nao_acionar`,
--    juridico, cancelamento e suspensao de cobranca, confirmacao financeira
--    aberta e pagamento em transito seguem barrados (artigo 6).
--  * Caso de OPERADOR ATIVO continua recusado. E isso que protege a
--    fidelizacao do colega (artigo 3).
--  * Caso com marca de giro VIVA continua recusado, com a mesma mensagem.
--  * Titularidade financeira: a funcao nao le nem escreve
--    `acordos.operador_responsavel_email`. Nenhuma linha de `acordos` e tocada.
--  * `data_ultimo_acionamento`, `data_retorno` e a agenda: nao sao escritos.
--    Assumir NAO inicia fidelizacao -- a propria mensagem de sucesso diz isso, e
--    continua dizendo.
--  * Nenhuma outra funcao, nenhum gatilho, nenhuma tabela, nenhuma regra de
--    baixa.
--
-- COMO E APLICADO
--
-- Por PATCH ANCORADO (`internal.patch_funcao_ancorada`), que e o padrao da casa
-- para esta funcao -- ela ja recebeu patch ancorado do giro em 20261016190000.
-- Cada patch confere a contagem da ancora e recusa se a funcao tiver mudado, e e
-- idempotente pelo texto NOVO. Nenhuma reescrita cega de corpo.
--
-- Reversivel: supabase/rollbacks/20261020230350_*.rollback.sql

-- ===========================================================================
-- 1. DECLARE -- duas variaveis novas
-- ===========================================================================
select internal.patch_funcao_ancorada(
  'public', 'assumir_caso_livre',
$ancora$  v_rel record; v_liberado uuid := null;$ancora$,
$novo$  v_rel record; v_liberado uuid := null;
  -- v_teto: teto oficial da gestao. v_pool: qual das tres carteiras de livre
  -- assuncao cedeu o caso (nulo quando veio da fila livre ou de um caso de giro).
  v_teto int; v_pool text;$novo$,
  1);

-- ===========================================================================
-- 2. AS TRES CARTEIRAS DE LIVRE ASSUNCAO
-- ===========================================================================
-- O que caracteriza as tres, por definicao e sem lista fixa de e-mail: o dono
-- atual NAO e um operador ativo. Isso cobre a Carteira Geral (pseudo-operador),
-- a Olga (inativa) e a gestao/ADM (perfil diferente de `operador`) -- e cobre
-- sozinho qualquer pessoa que seja desligada depois, sem migration nova.
select internal.patch_funcao_ancorada(
  'public', 'assumir_caso_livre',
$ancora$  if coalesce(v_new.operador_email,'') <> '' then
    if public.caso_em_giro_fidelizacao(v_new.giro_fidelizacao_ate) then$ancora$,
$novo$  if coalesce(v_new.operador_email,'') <> '' then
    -- Artigo 2: Carteira Geral, carteira da gestao e antiga carteira da Olga
    -- sao de LIVRE ASSUNCAO -- qualquer operador assume na hora, sem esperar os
    -- 10 dias. O criterio e estrutural: o dono atual nao e operador ativo.
    select case
             when lower(v_new.operador_email) = internal.carteira_geral_email()
               then 'Carteira Geral'
             when not exists (select 1 from public.usuarios u
                               where lower(u.email) = lower(v_new.operador_email)
                                 and u.ativo and u.perfil = 'operador')
               then 'carteira de ' || coalesce((select u.nome from public.usuarios u
                                                 where lower(u.email) = lower(v_new.operador_email)
                                                 limit 1), v_new.operador_email)
           end into v_pool;

    if public.caso_em_giro_fidelizacao(v_new.giro_fidelizacao_ate) then$novo$,
  1);

-- A recusa "ja foi assumido por outro operador" passa a valer so para caso de
-- operador ATIVO. Com v_pool preenchido, segue adiante e troca o dono.
select internal.patch_funcao_ancorada(
  'public', 'assumir_caso_livre',
$ancora$    if v_new.giro_fidelizacao_ate is null then
      return query select false,'Este caso ja foi assumido por outro operador.',null::uuid; return;
    end if;$ancora$,
$novo$    if v_pool is null and v_new.giro_fidelizacao_ate is null then
      return query select false,'Este caso ja foi assumido por outro operador.',null::uuid; return;
    end if;$novo$,
  1);

-- ===========================================================================
-- 3. O TETO -- fonte oficial e a MESMA base de contagem do teto
-- ===========================================================================
select internal.patch_funcao_ancorada(
  'public', 'assumir_caso_livre',
$ancora$  v_count := (select count(*) from public.casos where operador_email = v_email
                 and not public.caso_aguarda_confirmacao_financeira(aluno_id));
  if v_count >= 500 then$ancora$,
$novo$  -- Teto oficial da gestao, nao numero literal.
  v_teto := public.calibragem_teto_operador(v_email);
  -- MESMA base que `trg_impor_teto_operador` cobra: nao protegido e nao
  -- encerrado. A base antiga (carteira inteira menos confirmacao financeira)
  -- dava ~1.000 por operador e por isso recusava toda assuncao.
  v_count := (select count(*) from public.casos c where c.operador_email = v_email
                 and not public.caso_protegido_redistribuicao(c.cpf_limpo,c.status_acionamento,c.nao_acionar,c.status_financeiro,c.valor_pago,c.quitado_em,c.valor_quitado)
                 and not public.caso_encerrado_operacional(c.cpf_limpo,c.status_atual,c.status_acionamento,c.status_financeiro,c.status_jornada));
  if v_count >= v_teto then$novo$,
  1);

select internal.patch_funcao_ancorada(
  'public', 'assumir_caso_livre',
$ancora$      return query select false,'Carteira cheia (500) e nenhum caso livre para trocar. Assuncao nao realizada.',null::uuid; return;$ancora$,
$novo$      return query select false,'Carteira cheia ('||v_teto||' casos) e nenhum caso livre para trocar. Assuncao nao realizada.',null::uuid; return;$novo$,
  1);

-- ===========================================================================
-- 4. A GUARDA FINAL -- atomica, pela mesma base e pelo teto vigente
-- ===========================================================================
-- Esta e a guarda que garante o artigo 5 ("cada caso assumido conta imediatamente
-- e respeita o teto"): ela roda DEPOIS do update, dentro da mesma transacao, e
-- `raise exception` desfaz a assuncao inteira -- inclusive a liberacao por troca
-- e as duas linhas de historico.
select internal.patch_funcao_ancorada(
  'public', 'assumir_caso_livre',
$ancora$  if (select count(*) from public.casos where operador_email = v_email
                 and not public.caso_aguarda_confirmacao_financeira(aluno_id)) > 500 then
    raise exception 'ROLLBACK: operador ficaria com mais de 500 casos.';
  end if;$ancora$,
$novo$  if (select count(*) from public.casos c where c.operador_email = v_email
                 and not public.caso_protegido_redistribuicao(c.cpf_limpo,c.status_acionamento,c.nao_acionar,c.status_financeiro,c.valor_pago,c.quitado_em,c.valor_quitado)
                 and not public.caso_encerrado_operacional(c.cpf_limpo,c.status_atual,c.status_acionamento,c.status_financeiro,c.status_jornada)) > v_teto then
    raise exception 'ROLLBACK: operador ficaria com mais de % casos (teto vigente).', v_teto;
  end if;$novo$,
  1);

-- ===========================================================================
-- 5. TRILHA -- de qual carteira o caso veio
-- ===========================================================================
-- Auditabilidade (artigo 6): o historico passa a dizer de onde o caso saiu, em
-- vez de "caso livre" para tudo. Mesma tabela, mesma acao, mesma linha.
select internal.patch_funcao_ancorada(
  'public', 'assumir_caso_livre',
$ancora$    'Assumido caso livre. assumido_por='||v_email$ancora$,
$novo$    'Assumido de '||coalesce(v_pool,'fila livre')||'. assumido_por='||v_email$novo$,
  1);
