-- COMPLEMENTO para o teste de `assumir_caso_fidelizacao_vencida` -- 13/11/2026.
-- ATENCAO: o bloco de aluno_retorno_operador_vigente NAO e de producao: e a copia do arquivo da PR #936
-- (md5 25412bfe...). So sera producao depois da #936 implantada e conferida.
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

-- Gatilho que impede apagar o acionamento do aluno na troca de dono.
-- Sem ele, set_resp_aluno zera data_ultimo_acionamento e status_acionamento.
CREATE OR REPLACE FUNCTION public._acionamento_nao_volta_para_nulo()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  -- Acionamento e fato consumado: uma vez registrado, nao se apaga.
  if old.data_ultimo_acionamento is not null and new.data_ultimo_acionamento is null then
    new.data_ultimo_acionamento := old.data_ultimo_acionamento;
  end if;

  -- A tabulacao do contato acompanha o acionamento.
  if old.status_acionamento is not null
     and nullif(btrim(old.status_acionamento),'') is not null
     and new.status_acionamento is null then
    new.status_acionamento := old.status_acionamento;
  end if;

  return new;
end;
$function$;

drop trigger if exists trg_acionamento_nao_volta_para_nulo on public.alunos;
CREATE TRIGGER trg_acionamento_nao_volta_para_nulo BEFORE UPDATE OF data_ultimo_acionamento, status_acionamento ON public.alunos FOR EACH ROW EXECUTE FUNCTION _acionamento_nao_volta_para_nulo();

-- Permissao de gestao para reverter (corpo de producao, md5 9ece7c66...).
CREATE OR REPLACE FUNCTION internal.pode_alterar_responsavel()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select coalesce((select u.pode_alterar_responsavel and u.ativo from public.usuarios u
     where lower(u.email)=lower(coalesce(auth.jwt()->>'email','')) limit 1), false); $function$;

-- PRE-CONDICAO P2 (PR #936, head 7670f20c, candidato a artefato final): copia do arquivo da #936.
-- Quando a #936 for aplicada, confirmar o md5 abaixo contra producao antes de aplicar a #953.
CREATE OR REPLACE FUNCTION public.aluno_retorno_operador_vigente(p_aluno_id uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select exists (
    select 1
      from public.alunos a
     where a.id = p_aluno_id
       and a.responsavel_atual_email is not null
       and a.data_retorno is not null
       and upper(coalesce(a.retorno_origem, '')) like 'OPERADOR%'
       and a.retorno_confirmado_em is null
       and exists (
             select 1 from public.aluno_movimentacoes m
              where m.aluno_id = a.id::text
                and m.tipo = 'FINALIZACAO_ATENDIMENTO'
                and lower(m.registrado_por_email) = lower(a.responsavel_atual_email)
                and m.registrado_em >= coalesce(a.responsavel_atual_em, '-infinity'::timestamptz)
                and m.data_retorno is not null
                -- associacao (nao expiracao): o retorno nao pode estar a mais de 15 dias
                -- depois do atendimento que o registrou. Parametro provisorio.
                and a.data_retorno <= (m.registrado_em at time zone 'America/Sao_Paulo')::date + 15
       )
  );
$function$;

