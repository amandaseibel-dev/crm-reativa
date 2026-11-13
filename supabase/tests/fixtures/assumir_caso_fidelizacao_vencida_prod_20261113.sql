-- COMPLEMENTO DE PRODUCAO para o teste de `assumir_caso_fidelizacao_vencida` -- 13/11/2026.
--
-- Leitura somente de estrutura e corpo de funcao (information_schema, pg_constraint,
-- pg_get_functiondef), feita no banco de producao sem nenhuma escrita. NENHUM DADO
-- REAL: nao ha linha de producao aqui. Hashes em
-- `assumir_caso_fidelizacao_vencida_prod_20261113.md5.json` (md5 do prosrc).
--
-- Depende do que ja esta nas fixtures anteriores: casos, alunos, calibragem_parametros,
-- caso_protegido_redistribuicao, caso_encerrado_operacional e saldo_titulos_aberto.

-- Tabela consultada por caso_encerramento_congelado (encerramento sem saldo congelado).
CREATE SEQUENCE IF NOT EXISTS public.caso_encerramento_sem_saldo_id_seq;

CREATE TABLE IF NOT EXISTS public.caso_encerramento_sem_saldo (
  id bigint NOT NULL DEFAULT nextval('caso_encerramento_sem_saldo_id_seq'::regclass),
  escopo text NOT NULL,
  caso_id uuid,
  aluno_id uuid,
  cpf_congelado text,
  classificacao text NOT NULL,
  saldo_no_momento numeric,
  estado_anterior jsonb NOT NULL,
  justificativa text NOT NULL,
  decidido_por text,
  decidido_em timestamp with time zone,
  origem text NOT NULL,
  evidencia jsonb,
  resolvido_em timestamp with time zone,
  resolvido_por text,
  registrado_em timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT caso_encerramento_sem_saldo_pkey PRIMARY KEY (id),
  CONSTRAINT caso_encerramento_sem_saldo_alvo_check CHECK (
    ((escopo = 'CASO'::text) AND (caso_id IS NOT NULL)) OR ((escopo = 'ALUNO'::text) AND (aluno_id IS NOT NULL))),
  CONSTRAINT caso_encerramento_sem_saldo_caso_id_fkey FOREIGN KEY (caso_id)
    REFERENCES public.casos(id) ON DELETE CASCADE,
  CONSTRAINT caso_encerramento_sem_saldo_classificacao_check CHECK (
    classificacao = ANY (ARRAY['SEM_SALDO_CONFERIDO'::text, 'BLOQUEIO_INSTITUCIONAL'::text, 'NAO_ACIONAR'::text,
      'OUTRO_CASO_ATIVO'::text, 'LEGADO_NAO_CONFERIDO'::text, 'ALUNO_LEGADO_NAO_CONFERIDO'::text,
      'SALDO_NAO_COMPROVADO'::text, 'MANTIDO_PELA_GESTAO'::text, 'DEVOLVIDO_A_COBRANCA'::text])),
  CONSTRAINT caso_encerramento_sem_saldo_escopo_check CHECK (escopo = ANY (ARRAY['CASO'::text, 'ALUNO'::text])),
  CONSTRAINT caso_encerramento_sem_saldo_origem_check CHECK (origem = ANY (ARRAY['ROTINA'::text, 'GESTAO'::text, 'MIGRATION'::text]))
);

-- ===========================================================================
-- public.caso_encerramento_congelado
-- ===========================================================================
CREATE OR REPLACE FUNCTION public.caso_encerramento_congelado(p_caso_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select exists (select 1 from public.caso_encerramento_sem_saldo e
                  where e.resolvido_em is null and e.caso_id = p_caso_id);
$function$;
