-- Teste do vigia de sessões do WhatsApp (whatsapp_monitorar_sessoes)
-- =============================================================================
-- COMO RODAR: cole inteiro no SQL Editor do ambiente de teste (NUNCA em
-- produção com operação rodando — ele cria canais e notificações de mentira,
-- e apaga tudo no fim).
--
-- BLOCO A — servidor fora do ar (heartbeat parado)
-- BLOCO B — servidor no ar, SESSÃO indisponível (QR / erro)
-- BLOCO C — recuperação, não duplicidade e falso alerta de setup
-- =============================================================================

DROP TABLE IF EXISTS _wa_resultado;
CREATE TEMP TABLE _wa_resultado (n int, caso text, esperado text, obtido text, ok boolean);

DO $teste$
DECLARE
  v_limite_original integer;
  v_caiu uuid; v_ok uuid; v_nunca uuid; v_inativo uuid;
  v_qr uuid; v_aguard uuid; v_erro uuid; v_desc uuid;
  v_setup_qr uuid; v_setup_erro uuid;
  v_qtd integer; v_txt text; v_acoes text;
BEGIN
  SELECT minutos_sem_heartbeat_alerta INTO v_limite_original FROM public.whatsapp_config WHERE id;
  UPDATE public.whatsapp_config SET minutos_sem_heartbeat_alerta = 5 WHERE id;

  -- ==========================================================================
  -- BLOCO A — servidor sem heartbeat
  -- ==========================================================================
  INSERT INTO public.whatsapp_canais (sessao_chave, display_phone_number, apelido, ativo, conexao_status, conectado_em, ultimo_heartbeat_em)
  VALUES ('mon-caiu', '+55 51 90000-0001', 'Cobranca MON', true, 'CONECTADO', now() - interval '2 days', now() - interval '30 minutes')
  RETURNING id INTO v_caiu;
  INSERT INTO public.whatsapp_canais (sessao_chave, display_phone_number, apelido, ativo, conexao_status, conectado_em, ultimo_heartbeat_em)
  VALUES ('mon-ok', '+55 51 90000-0002', 'Comercial MON', true, 'CONECTADO', now() - interval '2 days', now())
  RETURNING id INTO v_ok;
  INSERT INTO public.whatsapp_canais (sessao_chave, display_phone_number, apelido, ativo, conexao_status, conectado_em, ultimo_heartbeat_em)
  VALUES ('mon-nunca', '+55 51 90000-0003', 'Novo MON', true, 'DESCONECTADO', NULL, NULL)
  RETURNING id INTO v_nunca;
  INSERT INTO public.whatsapp_canais (sessao_chave, display_phone_number, apelido, ativo, conexao_status, conectado_em, ultimo_heartbeat_em)
  VALUES ('mon-inativo', '+55 51 90000-0004', 'Desligado MON', false, 'CONECTADO', now() - interval '2 days', now() - interval '3 hours')
  RETURNING id INTO v_inativo;

  SELECT string_agg(nome_canal || '=' || acao || '/' || coalesce(motivo,'-'), ', ' ORDER BY nome_canal)
    INTO v_acoes FROM public.whatsapp_monitorar_sessoes();

  INSERT INTO _wa_resultado VALUES
    (1, 'canal que nunca conectou nao alerta', 'sem Novo MON', coalesce(v_acoes,'(nada)'), coalesce(v_acoes,'') NOT LIKE '%Novo MON%'),
    (2, 'canal com sinal recente nao alerta', 'sem Comercial MON', coalesce(v_acoes,'(nada)'), coalesce(v_acoes,'') NOT LIKE '%Comercial MON%'),
    (3, 'canal inativo e ignorado', 'sem Desligado MON', coalesce(v_acoes,'(nada)'), coalesce(v_acoes,'') NOT LIKE '%Desligado MON%'),
    (4, 'sem heartbeat alerta com motivo SEM_HEARTBEAT', 'Cobranca MON=ALERTA/SEM_HEARTBEAT', coalesce(v_acoes,'(nada)'),
        coalesce(v_acoes,'') LIKE '%Cobranca MON=ALERTA/SEM_HEARTBEAT%');

  SELECT count(*) INTO v_qtd FROM public.notificacoes WHERE tipo='WHATSAPP_SESSAO_FORA';
  INSERT INTO _wa_resultado VALUES (5, 'avisou os 3 da gestao', '3', v_qtd::text, v_qtd = 3);

  SELECT titulo || ' | ' || mensagem INTO v_txt FROM public.notificacoes
   WHERE tipo='WHATSAPP_SESSAO_FORA' ORDER BY criado_em DESC LIMIT 1;
  INSERT INTO _wa_resultado VALUES
    (6, 'identifica o numero', 'contem +55 51 90000-0001', left(coalesce(v_txt,''),70), coalesce(v_txt,'') LIKE '%+55 51 90000-0001%'),
    (7, 'identifica o apelido', 'contem Cobranca MON', left(coalesce(v_txt,''),70), coalesce(v_txt,'') LIKE '%Cobranca MON%'),
    (8, 'diz ha quanto tempo', 'contem "30 min"', left(coalesce(v_txt,''),90), coalesce(v_txt,'') LIKE '%30 min%'),
    (9, 'titulo de servidor sem sinal', 'contem "servidor sem sinal"', left(coalesce(v_txt,''),60), coalesce(v_txt,'') LIKE '%servidor sem sinal%'),
    (10, 'texto diz que e o SERVIDOR, nao a sessao', 'contem "e o servidor"', left(coalesce(v_txt,''),160), coalesce(v_txt,'') LIKE '%é o servidor%'),
    (11, 'texto de servidor NAO fala em QR Code', 'sem "QR"', left(coalesce(v_txt,''),160), coalesce(v_txt,'') NOT LIKE '%QR%'),
    (12, 'aviso aponta para a Central', '/central-whatsapp',
         (SELECT coalesce(url_destino,'') FROM public.notificacoes WHERE tipo='WHATSAPP_SESSAO_FORA' ORDER BY criado_em DESC LIMIT 1),
         (SELECT url_destino FROM public.notificacoes WHERE tipo='WHATSAPP_SESSAO_FORA' ORDER BY criado_em DESC LIMIT 1) = '/central-whatsapp');

  SELECT count(*) INTO v_qtd FROM public.whatsapp_monitorar_sessoes();
  INSERT INTO _wa_resultado VALUES (13, 'rodar de novo nao repete', '0 acoes', v_qtd::text, v_qtd = 0);
  SELECT count(*) INTO v_qtd FROM public.notificacoes WHERE tipo='WHATSAPP_SESSAO_FORA';
  INSERT INTO _wa_resultado VALUES (14, 'continua com 3 notificacoes', '3', v_qtd::text, v_qtd = 3);

  UPDATE public.whatsapp_canais SET alerta_ultimo_em = now() - interval '61 minutes' WHERE id = v_caiu;
  SELECT count(*) INTO v_qtd FROM public.whatsapp_monitorar_sessoes();
  INSERT INTO _wa_resultado VALUES (15, 'passada 1h avisa de novo', '1 acao', v_qtd::text, v_qtd = 1);
  SELECT count(*) INTO v_qtd FROM public.notificacoes WHERE tipo='WHATSAPP_SESSAO_FORA';
  INSERT INTO _wa_resultado VALUES (16, 'agora sao 6 notificacoes', '6', v_qtd::text, v_qtd = 6);

  SELECT mensagem INTO v_txt FROM public.notificacoes WHERE tipo='WHATSAPP_SESSAO_FORA' ORDER BY criado_em DESC LIMIT 1;
  INSERT INTO _wa_resultado VALUES (17, 'segundo aviso mantem a espera acumulada', 'contem "30 min"', left(coalesce(v_txt,''),90), coalesce(v_txt,'') LIKE '%30 min%');

  UPDATE public.whatsapp_config SET minutos_sem_heartbeat_alerta = 120 WHERE id;
  UPDATE public.whatsapp_canais SET alerta_fora_desde=NULL, alerta_ultimo_em=NULL, alerta_motivo=NULL,
         ultimo_heartbeat_em = now() - interval '30 minutes' WHERE id = v_caiu;
  SELECT count(*) INTO v_qtd FROM public.whatsapp_monitorar_sessoes();
  INSERT INTO _wa_resultado VALUES (18, 'limite 120min: 30min sem sinal nao alerta', '0 acoes', v_qtd::text, v_qtd = 0);

  UPDATE public.whatsapp_config SET minutos_sem_heartbeat_alerta = 5 WHERE id;
  SELECT count(*) INTO v_qtd FROM public.whatsapp_monitorar_sessoes();
  INSERT INTO _wa_resultado VALUES (19, 'limite 5min: passa a alertar', '1 acao', v_qtd::text, v_qtd = 1);

  -- ==========================================================================
  -- BLOCO B — servidor VIVO, sessão indisponível
  -- ==========================================================================
  DELETE FROM public.notificacoes WHERE tipo IN ('WHATSAPP_SESSAO_FORA','WHATSAPP_SESSAO_VOLTOU');

  INSERT INTO public.whatsapp_canais (sessao_chave, display_phone_number, apelido, ativo, conexao_status, conexao_detalhe, conectado_em, ultimo_heartbeat_em)
  VALUES ('mon-qr', '+55 51 90000-0005', 'QR MON', true, 'PAREAMENTO_NECESSARIO', 'a sessao foi encerrada no celular', now() - interval '3 days', now() - interval '20 seconds')
  RETURNING id INTO v_qr;
  INSERT INTO public.whatsapp_canais (sessao_chave, display_phone_number, apelido, ativo, conexao_status, conectado_em, ultimo_heartbeat_em)
  VALUES ('mon-aguard', '+55 51 90000-0006', 'Aguard MON', true, 'AGUARDANDO_QR', now() - interval '3 days', now() - interval '20 seconds')
  RETURNING id INTO v_aguard;
  INSERT INTO public.whatsapp_canais (sessao_chave, display_phone_number, apelido, ativo, conexao_status, conexao_detalhe, conectado_em, ultimo_heartbeat_em)
  VALUES ('mon-erro', '+55 51 90000-0007', 'Erro MON', true, 'ERRO', 'outro dispositivo assumiu esta sessao', now() - interval '3 days', now() - interval '20 seconds')
  RETURNING id INTO v_erro;
  -- DESCONECTADO com servidor vivo e transitorio: NAO pode alertar
  INSERT INTO public.whatsapp_canais (sessao_chave, display_phone_number, apelido, ativo, conexao_status, conectado_em, ultimo_heartbeat_em)
  VALUES ('mon-desc', '+55 51 90000-0008', 'Desc MON', true, 'DESCONECTADO', now() - interval '3 days', now() - interval '20 seconds')
  RETURNING id INTO v_desc;
  -- setup: nunca conectou, esperando o primeiro pareamento
  INSERT INTO public.whatsapp_canais (sessao_chave, display_phone_number, apelido, ativo, conexao_status, conectado_em, ultimo_heartbeat_em)
  VALUES ('mon-setup-qr', '+55 51 90000-0009', 'Setup QR MON', true, 'AGUARDANDO_QR', NULL, now() - interval '20 seconds')
  RETURNING id INTO v_setup_qr;
  INSERT INTO public.whatsapp_canais (sessao_chave, display_phone_number, apelido, ativo, conexao_status, conectado_em, ultimo_heartbeat_em)
  VALUES ('mon-setup-erro', '+55 51 90000-0010', 'Setup Erro MON', true, 'ERRO', NULL, now() - interval '20 seconds')
  RETURNING id INTO v_setup_erro;

  SELECT string_agg(nome_canal || '=' || acao || '/' || coalesce(motivo,'-'), ', ' ORDER BY nome_canal)
    INTO v_acoes FROM public.whatsapp_monitorar_sessoes();

  INSERT INTO _wa_resultado VALUES
    (20, 'PAREAMENTO_NECESSARIO com servidor vivo alerta', 'QR MON=ALERTA/PAREAMENTO_NECESSARIO', coalesce(v_acoes,'(nada)'),
         coalesce(v_acoes,'') LIKE '%QR MON=ALERTA/PAREAMENTO_NECESSARIO%'),
    (21, 'AGUARDANDO_QR alerta pela mesma causa', 'Aguard MON=ALERTA/PAREAMENTO_NECESSARIO', coalesce(v_acoes,'(nada)'),
         coalesce(v_acoes,'') LIKE '%Aguard MON=ALERTA/PAREAMENTO_NECESSARIO%'),
    (22, 'ERRO alerta com motivo ERRO', 'Erro MON=ALERTA/ERRO', coalesce(v_acoes,'(nada)'),
         coalesce(v_acoes,'') LIKE '%Erro MON=ALERTA/ERRO%'),
    (23, 'DESCONECTADO com servidor vivo NAO alerta', 'sem Desc MON', coalesce(v_acoes,'(nada)'),
         coalesce(v_acoes,'') NOT LIKE '%Desc MON%'),
    (24, 'SETUP: AGUARDANDO_QR sem nunca ter conectado nao alerta', 'sem Setup QR MON', coalesce(v_acoes,'(nada)'),
         coalesce(v_acoes,'') NOT LIKE '%Setup QR MON%'),
    (25, 'SETUP: ERRO sem nunca ter conectado nao alerta', 'sem Setup Erro MON', coalesce(v_acoes,'(nada)'),
         coalesce(v_acoes,'') NOT LIKE '%Setup Erro MON%');

  SELECT titulo || ' | ' || mensagem INTO v_txt FROM public.notificacoes
   WHERE tipo='WHATSAPP_SESSAO_FORA' AND titulo LIKE '%QR MON%' ORDER BY criado_em DESC LIMIT 1;
  INSERT INTO _wa_resultado VALUES
    (26, 'mensagem de QR tem titulo proprio', 'contem "precisa de QR Code novo"', left(coalesce(v_txt,''),70),
         coalesce(v_txt,'') LIKE '%precisa de QR Code novo%'),
    (27, 'mensagem de QR diz que o SERVIDOR esta no ar', 'contem "servidor esta no ar"', left(coalesce(v_txt,''),150),
         coalesce(v_txt,'') LIKE '%servidor está no ar%'),
    (28, 'mensagem de QR manda ler o QR na Central', 'contem "ler o QR Code na Central"', left(coalesce(v_txt,''),200),
         coalesce(v_txt,'') LIKE '%ler o QR Code na Central%');

  SELECT titulo || ' | ' || mensagem INTO v_txt FROM public.notificacoes
   WHERE tipo='WHATSAPP_SESSAO_FORA' AND titulo LIKE '%Erro MON%' ORDER BY criado_em DESC LIMIT 1;
  INSERT INTO _wa_resultado VALUES
    (29, 'mensagem de erro tem titulo proprio', 'contem "sessão com erro"', left(coalesce(v_txt,''),70),
         coalesce(v_txt,'') LIKE '%sessão com erro%'),
    (30, 'mensagem de erro traz o detalhe tecnico', 'contem "outro dispositivo assumiu"', left(coalesce(v_txt,''),200),
         coalesce(v_txt,'') LIKE '%outro dispositivo assumiu%');

  -- os tres motivos produzem titulos DIFERENTES
  SELECT count(DISTINCT titulo) INTO v_qtd FROM public.notificacoes WHERE tipo='WHATSAPP_SESSAO_FORA';
  INSERT INTO _wa_resultado VALUES (31, 'os tres motivos geram titulos distintos', '3 titulos distintos', v_qtd::text, v_qtd = 3);

  -- trava de 1h vale para os motivos novos
  SELECT count(*) INTO v_qtd FROM public.whatsapp_monitorar_sessoes();
  INSERT INTO _wa_resultado VALUES (32, 'trava de 1h vale para QR e ERRO', '0 acoes', v_qtd::text, v_qtd = 0);

  -- motivo muda no meio da queda: o servidor tambem morre
  UPDATE public.whatsapp_canais SET ultimo_heartbeat_em = now() - interval '40 minutes' WHERE id = v_qr;
  SELECT string_agg(acao || '/' || coalesce(motivo,'-'), ',') INTO v_acoes FROM public.whatsapp_monitorar_sessoes();
  INSERT INTO _wa_resultado VALUES
    (33, 'motivo mudando gera MOTIVO_MUDOU', 'MOTIVO_MUDOU/SEM_HEARTBEAT', coalesce(v_acoes,'(nada)'),
         coalesce(v_acoes,'') = 'MOTIVO_MUDOU/SEM_HEARTBEAT');

  SELECT count(*) INTO v_qtd FROM public.notificacoes WHERE tipo='WHATSAPP_SESSAO_FORA';
  INSERT INTO _wa_resultado VALUES (34, 'mudanca de motivo NAO manda notificacao nova', '9 (segue igual)', v_qtd::text, v_qtd = 9);

  SELECT count(*) INTO v_qtd FROM public.whatsapp_conexao_eventos WHERE canal_id=v_qr AND evento='ALERTA_MOTIVO_MUDOU';
  INSERT INTO _wa_resultado VALUES (35, 'mudanca de motivo fica no diario', '1', v_qtd::text, v_qtd = 1);

  -- ==========================================================================
  -- BLOCO C — recuperação e não duplicidade
  -- ==========================================================================
  -- AGUARDANDO_QR nao e recuperacao: ainda depende de alguem escanear
  UPDATE public.whatsapp_canais SET conexao_status='AGUARDANDO_QR', ultimo_heartbeat_em=now() WHERE id=v_aguard;
  SELECT count(*) INTO v_qtd FROM public.whatsapp_monitorar_sessoes() WHERE acao='RECUPERACAO';
  INSERT INTO _wa_resultado VALUES (36, 'AGUARDANDO_QR nao conta como recuperacao', '0 recuperacoes', v_qtd::text, v_qtd = 0);

  -- CONECTANDO tambem nao
  UPDATE public.whatsapp_canais SET conexao_status='CONECTANDO', ultimo_heartbeat_em=now() WHERE id=v_erro;
  SELECT count(*) INTO v_qtd FROM public.whatsapp_monitorar_sessoes() WHERE acao='RECUPERACAO';
  INSERT INTO _wa_resultado VALUES (37, 'CONECTANDO nao conta como recuperacao', '0', v_qtd::text, v_qtd = 0);

  -- volta de verdade
  UPDATE public.whatsapp_canais SET conexao_status='CONECTADO', ultimo_heartbeat_em=now() WHERE id=v_erro;
  SELECT string_agg(nome_canal || '=' || acao, ',') INTO v_acoes
    FROM public.whatsapp_monitorar_sessoes() WHERE acao='RECUPERACAO';
  INSERT INTO _wa_resultado VALUES
    (38, 'CONECTADO gera RECUPERACAO', 'Erro MON=RECUPERACAO', coalesce(v_acoes,'(nada)'), coalesce(v_acoes,'') = 'Erro MON=RECUPERACAO');

  SELECT count(*) INTO v_qtd FROM public.notificacoes WHERE tipo='WHATSAPP_SESSAO_VOLTOU';
  INSERT INTO _wa_resultado VALUES (39, 'recuperacao avisa os 3 da gestao, uma vez so', '3', v_qtd::text, v_qtd = 3);

  SELECT mensagem INTO v_txt FROM public.notificacoes WHERE tipo='WHATSAPP_SESSAO_VOLTOU' ORDER BY criado_em DESC LIMIT 1;
  INSERT INTO _wa_resultado VALUES
    (40, 'recuperacao diz de que motivo voltou', 'contem "(ERRO)"', left(coalesce(v_txt,''),160), coalesce(v_txt,'') LIKE '%(ERRO)%');

  SELECT count(*) INTO v_qtd FROM public.whatsapp_conexao_eventos WHERE canal_id=v_erro AND evento='RECUPERADO';
  INSERT INTO _wa_resultado VALUES (41, 'recuperacao fica no diario', '1', v_qtd::text, v_qtd = 1);

  SELECT count(*) INTO v_qtd FROM public.whatsapp_canais
   WHERE id=v_erro AND alerta_fora_desde IS NULL AND alerta_ultimo_em IS NULL AND alerta_motivo IS NULL;
  INSERT INTO _wa_resultado VALUES (42, 'estado do alerta e limpo ao voltar', '1', v_qtd::text, v_qtd = 1);

  SELECT count(*) INTO v_qtd FROM public.whatsapp_monitorar_sessoes() WHERE acao='RECUPERACAO';
  INSERT INTO _wa_resultado VALUES (43, 'recuperacao nao dispara duas vezes', '0', v_qtd::text, v_qtd = 0);

  SELECT count(*) INTO v_qtd FROM public.notificacoes WHERE tipo='WHATSAPP_SESSAO_VOLTOU';
  INSERT INTO _wa_resultado VALUES (44, 'continua com 3 notificacoes de volta', '3', v_qtd::text, v_qtd = 3);

  -- ------------------------------------------------------------------ limpeza
  UPDATE public.whatsapp_config SET minutos_sem_heartbeat_alerta = coalesce(v_limite_original, 5) WHERE id;
  DELETE FROM public.notificacoes WHERE tipo IN ('WHATSAPP_SESSAO_FORA','WHATSAPP_SESSAO_VOLTOU');
  DELETE FROM public.whatsapp_conexao_eventos
   WHERE canal_id IN (v_caiu,v_ok,v_nunca,v_inativo,v_qr,v_aguard,v_erro,v_desc,v_setup_qr,v_setup_erro);
  DELETE FROM public.whatsapp_canais
   WHERE id IN (v_caiu,v_ok,v_nunca,v_inativo,v_qr,v_aguard,v_erro,v_desc,v_setup_qr,v_setup_erro);
END
$teste$;

SELECT n, CASE WHEN ok THEN 'PASSOU' ELSE 'FALHOU' END AS resultado, caso, esperado, obtido
FROM _wa_resultado ORDER BY n;
