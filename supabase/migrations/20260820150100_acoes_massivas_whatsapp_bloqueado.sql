-- Acoes Massivas pelo canal WHATSAPP: bloqueado nesta fase.
--
-- POR QUE: `registrar_acao_massiva` com p_canal='WHATSAPP' NAO envia nada. Ela
-- gera uma planilha XLSX com nome e telefone, e o disparo acontece FORA do
-- sistema -- nao passa pela Edge Function, nao passa pelo gateway, e a tabela
-- nem tem canal_id.
--
-- O problema nao e so nao dar para bloquear "por canal": e que o volume
-- disparado por essa via nao entra no teto de 100 do numero. Um lote de 500
-- sairia por fora e o contador continuaria marcando zero, esvaziando o controle
-- de cadencia justamente no ponto que mais importa.
--
-- TRAVA DE FASE, nao desenho final. O certo e amarrar Acoes Massivas a um
-- canal_id e faze-la consumir a mesma cota, para o teto valer para a empresa e
-- nao so para a Central. Esta no backlog.
--
-- E-mail continua liberado: nao tem relacao com a cadencia do WhatsApp.
--
-- POR QUE A CIRURGIA E FEITA NO BANCO E NAO RECOPIANDO A FUNCAO: o corpo tem
-- mais de 150 linhas de regra financeira que nao tem nada a ver com esta
-- mudanca. Reescrever tudo para inserir seis linhas significa arriscar um erro
-- de transcricao em codigo que move dinheiro. Aqui a definicao VIVA e lida,
-- a guarda e inserida na ancora, e o resultado e reinstalado -- fiel por
-- construcao.
--
-- E falha ALTO: se a ancora nao aparecer exatamente uma vez, ou se a guarda ja
-- estiver la, a migration aborta em vez de instalar algo diferente do esperado.
DO $migration$
DECLARE
  v_def   text;
  v_ancora text := 'RAISE EXCEPTION ''Acesso negado: registrar acao massiva restrito a gestao ou executor tecnico.'' USING ERRCODE = ''42501'';
  END IF;';
  v_guarda text;
BEGIN
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'registrar_acao_massiva';

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'registrar_acao_massiva nao existe neste banco';
  END IF;

  IF position('Acoes Massivas por WhatsApp estao suspensas' IN v_def) > 0 THEN
    RAISE NOTICE 'guarda ja instalada; nada a fazer';
    RETURN;
  END IF;

  IF (length(v_def) - length(replace(v_def, v_ancora, ''))) / length(v_ancora) <> 1 THEN
    RAISE EXCEPTION 'ancora nao encontrada exatamente uma vez em registrar_acao_massiva -- a funcao mudou, revise a migration antes de aplicar';
  END IF;

  v_guarda := v_ancora || '

  -- Vale inclusive para o executor tecnico: se algum automatismo chamar com
  -- WHATSAPP, e melhor falhar alto do que disparar em massa por fora do teto.
  IF upper(coalesce(p_canal, '''')) = ''WHATSAPP'' THEN
    RAISE EXCEPTION ''Acoes Massivas por WhatsApp estao suspensas: o disparo sai fora do controle de cadencia e nao entra no teto diario do numero. Use a Central para iniciar conversas.''
      USING ERRCODE = ''42501'';
  END IF;';

  EXECUTE replace(v_def, v_ancora, v_guarda);

  -- Confere que entrou mesmo.
  SELECT pg_get_functiondef(p.oid) INTO v_def
  FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.proname = 'registrar_acao_massiva';

  IF position('Acoes Massivas por WhatsApp estao suspensas' IN v_def) = 0 THEN
    RAISE EXCEPTION 'a guarda nao ficou instalada';
  END IF;
END;
$migration$;
