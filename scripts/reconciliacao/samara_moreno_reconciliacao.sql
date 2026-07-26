-- ============================================================================
-- Reconciliação cadastral — Sâmara Moreno (matrículas 12876 × 12370)
-- ----------------------------------------------------------------------------
-- ATENÇÃO: este arquivo NÃO está em supabase/migrations/ de propósito.
--          Ele NÃO deve ser aplicado por deploy/CI. Execução é MANUAL e só
--          depois da confirmação do valor canônico da matrícula/nome no
--          sistema acadêmico.
--
-- Identidade JÁ COMPROVADA (mesma pessoa):
--   aluno_id canônico : 7a7460b8-8550-4583-bfea-9ea4e5e5a0fa
--   CPF canônico      : 01046168142
--
-- O QUE ESTE SCRIPT NÃO FAZ (regra 8):
--   - não altera cpf, aluno_id
--   - não altera acordos, parcelas, pagamentos, links, solicitações
--   - não altera responsáveis, carteira, fidelização, status financeiro
--   - não exclui nem funde registros
--
-- O QUE ELE FAZ (após confirmação):
--   - faz BACKUP das linhas de alunos e casos
--   - alinha SOMENTE campos cadastrais de exibição/busca (nome,
--     nome_normalizado e, opcionalmente, matricula)
--   - registra AUDITORIA
--   - traz ROLLBACK completo
-- ============================================================================

-- ############################################################################
-- PASSO 0 — CONFIRMAÇÃO OBRIGATÓRIA
-- Preencha os valores canônicos confirmados no sistema acadêmico e troque
-- v_confirmado para TRUE. Enquanto FALSE, o script ABORTA sem alterar nada.
-- ############################################################################

DO $$
DECLARE
  v_confirmado        boolean := false;  -- <=== troque para TRUE só após conferência

  v_aluno_id          uuid    := '7a7460b8-8550-4583-bfea-9ea4e5e5a0fa';

  -- Valores canônicos confirmados (ajuste conforme o sistema acadêmico):
  v_nome_canonico     text    := 'Sâmara Paola Ennes Moreno';  -- nome completo oficial
  v_matricula_canon   text    := '12876';                      -- matrícula confirmada
  -- Se as DUAS matrículas forem legítimas (rematrícula), NÃO sobrescreva:
  v_atualizar_matric  boolean := true;   -- false = preserva a matrícula atual em alunos

  v_norm              text;
  v_antes             jsonb;
BEGIN
  IF NOT v_confirmado THEN
    RAISE EXCEPTION 'ABORTADO: defina os valores canônicos e v_confirmado := true antes de executar.';
  END IF;

  -- normalização compatível com public.buscar_aluno (translate + lower)
  v_norm := lower(translate(v_nome_canonico,
    'áàâãäéèêëíìîïóòôõöúùûüçÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇ',
    'aaaaaeeeeiiiiooooouuuuc AAAAAEEEEIIIIOOOOOUUUUC'));

  -- ---- BACKUP (idempotente por data) --------------------------------------
  CREATE TABLE IF NOT EXISTS public.bkp_reconc_samara_20260726 AS
    SELECT 'alunos'::text AS origem, to_jsonb(a.*) AS linha, now() AS bkp_em
    FROM public.alunos a WHERE a.id = v_aluno_id
    UNION ALL
    SELECT 'casos'::text, to_jsonb(c.*), now()
    FROM public.casos c WHERE c.aluno_id = v_aluno_id;

  -- snapshot "antes" para auditoria
  SELECT to_jsonb(a.*) INTO v_antes FROM public.alunos a WHERE a.id = v_aluno_id;

  -- ---- CORREÇÃO CIRÚRGICA: alunos (somente campos cadastrais/busca) --------
  UPDATE public.alunos
     SET nome            = v_nome_canonico,
         nome_normalizado = v_norm,
         matricula       = CASE WHEN v_atualizar_matric THEN v_matricula_canon ELSE matricula END,
         updated_at      = now()
   WHERE id = v_aluno_id;

  -- ---- Alinhar o nome exibido no caso (matrícula do caso preservada) -------
  -- Mantém casos.matricula como está (é o vínculo que a operadora já enxerga);
  -- apenas uniformiza a grafia do nome de exibição.
  UPDATE public.casos
     SET nome            = v_nome_canonico,
         nome_aluno      = v_nome_canonico,
         nome_normalizado = v_norm
   WHERE aluno_id = v_aluno_id;

  -- ---- AUDITORIA ----------------------------------------------------------
  INSERT INTO public.auditoria (usuario, acao, tabela_afetada, registro_id, detalhes)
  VALUES (
    'reconciliacao-cadastral-samara',
    'RECONCILIACAO_CADASTRAL',
    'alunos,casos',
    v_aluno_id,
    jsonb_build_object(
      'caso', 'Sâmara Moreno 12876x12370',
      'antes', v_antes,
      'nome_canonico', v_nome_canonico,
      'matricula_canonica', v_matricula_canon,
      'matricula_atualizada', v_atualizar_matric,
      'cpf', '01046168142',
      'backup_tabela', 'public.bkp_reconc_samara_20260726'
    )
  );

  RAISE NOTICE 'Reconciliação aplicada para aluno_id %.', v_aluno_id;
END $$;

-- ============================================================================
-- ROLLBACK (executar isoladamente para desfazer, usando o backup)
-- ============================================================================
-- DO $$
-- DECLARE
--   v_aluno_id uuid := '7a7460b8-8550-4583-bfea-9ea4e5e5a0fa';
--   v_a jsonb;
--   v_c jsonb;
-- BEGIN
--   SELECT linha INTO v_a FROM public.bkp_reconc_samara_20260726
--     WHERE origem='alunos' LIMIT 1;
--   SELECT linha INTO v_c FROM public.bkp_reconc_samara_20260726
--     WHERE origem='casos' LIMIT 1;
--
--   UPDATE public.alunos SET
--     nome            = v_a->>'nome',
--     nome_normalizado = v_a->>'nome_normalizado',
--     matricula       = v_a->>'matricula',
--     updated_at      = now()
--   WHERE id = v_aluno_id;
--
--   UPDATE public.casos SET
--     nome            = v_c->>'nome',
--     nome_aluno      = v_c->>'nome_aluno',
--     nome_normalizado = v_c->>'nome_normalizado'
--   WHERE aluno_id = v_aluno_id;
--
--   INSERT INTO public.auditoria (usuario, acao, tabela_afetada, registro_id, detalhes)
--   VALUES ('reconciliacao-cadastral-samara','ROLLBACK_RECONCILIACAO','alunos,casos',
--           v_aluno_id, jsonb_build_object('restaurado_de','public.bkp_reconc_samara_20260726'));
-- END $$;
