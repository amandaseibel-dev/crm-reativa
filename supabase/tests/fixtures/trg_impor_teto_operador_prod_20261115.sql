-- Corpo de produção de public.trg_impor_teto_operador (catálogo somente leitura, 15/11/2026, projeto ahattpqrjmhkzsmnbdzs).
-- md5(prosrc) = 3d01bbd194b76dc8455e9dd47d395cca. Esta é a FONTE da verdade para o teste de teto.
CREATE OR REPLACE FUNCTION public.trg_impor_teto_operador() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_meta int; v_email text := NEW.operador_email; v_qtd_ativa int; v_excedente int; caso_rec record;
BEGIN
  IF coalesce(current_setting('calibragem.bypass_teto', true), 'off') = 'on' THEN RETURN NEW; END IF;
  IF v_email IS NULL OR v_email IS NOT DISTINCT FROM OLD.operador_email THEN RETURN NEW; END IF;
  IF NOT EXISTS (SELECT 1 FROM public.usuarios u WHERE u.email = v_email AND u.perfil = 'operador' AND u.ativo = true) THEN RETURN NEW; END IF;
  IF public.caso_protegido_redistribuicao(NEW.cpf_limpo, NEW.status_acionamento, NEW.nao_acionar, NEW.status_financeiro, NEW.valor_pago, NEW.quitado_em, NEW.valor_quitado) THEN RETURN NEW; END IF;

  -- Teto da gestao (geral ou individual). Cai em 500 se nao houver parametro.
  v_meta := public.calibragem_teto_operador(v_email);

  SELECT count(*) INTO v_qtd_ativa FROM public.casos c WHERE c.operador_email = v_email
    AND NOT public.caso_protegido_redistribuicao(c.cpf_limpo, c.status_acionamento, c.nao_acionar, c.status_financeiro, c.valor_pago, c.quitado_em, c.valor_quitado)
    AND NOT public.caso_encerrado_operacional(c.cpf_limpo, c.status_atual, c.status_acionamento, c.status_financeiro, c.status_jornada);
  v_excedente := v_qtd_ativa - v_meta;
  IF v_excedente <= 0 THEN RETURN NEW; END IF;
  FOR caso_rec IN SELECT id, chave_unificacao, nome, cpf FROM public.casos c WHERE c.operador_email = v_email AND c.id <> NEW.id
      AND NOT public.caso_protegido_redistribuicao(c.cpf_limpo, c.status_acionamento, c.nao_acionar, c.status_financeiro, c.valor_pago, c.quitado_em, c.valor_quitado)
      AND NOT internal.matricula_em_fidelizacao(c.aluno_id, c.matricula)
      AND NOT public.caso_dentro_prazo_fidelizacao(c.data_ultimo_acionamento)
     AND c.giro_fidelizacao_ate IS NULL
      AND NOT public.caso_encerrado_operacional(c.cpf_limpo, c.status_atual, c.status_acionamento, c.status_financeiro, c.status_jornada)
      ORDER BY total_em_aberto ASC NULLS FIRST LIMIT v_excedente LOOP
    UPDATE public.casos SET operador_email = NULL, operador_nome = NULL, operador = NULL WHERE id = caso_rec.id;
    INSERT INTO public.historico_operadores_alunos (chave_unificacao, nome_aluno, cpf_referencia, acao, operador_anterior_nome, operador_anterior_email, observacao, criado_em) VALUES (caso_rec.chave_unificacao, caso_rec.nome, caso_rec.cpf, 'LIBERACAO_AUTOMATICA_TETO_EXCEDIDO', NEW.operador_nome, v_email, 'Teto de ' || v_meta || ' casos excedido apos atribuicao manual -- liberado automaticamente (menor valor, fora dos 10 dias de fidelizacao)', now());
  END LOOP;
  RETURN NEW;
END; $$;
