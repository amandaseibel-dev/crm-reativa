-- COMPLEMENTO DE BANCADA · fidelização do giro segue os 10 dias (12/11/2026).
--
-- Carregar DEPOIS de, nesta ordem:
--   fidelizacao_por_dono_prod_20260930.sql
--   nivelamento_m3_prod_20261021.sql            (coluna do giro, função da marca, patch ancorado)
--   assumir_caso_livre_prod_20261020.sql
--   migrations/20261020230350_assumir_caso_livre_teto_oficial_e_tres_carteiras.sql
--   onda1_executor_prod_20261021.sql            (teto e gatilho que limpa a marca)
--
-- Com essa cadeia, `assumir_caso_livre`, `trg_impor_teto_operador` e
-- `giro_limpar_marca_ao_trocar_dono` já ficam com o md5 de produção de
-- 12/11/2026. Falta só o corpo abaixo: a base de 30/09 traz
-- `liberar_fidelizacao_caso` de ANTES do giro (sem a guarda da marca).
--
-- Corpo EXATO de produção em 12/11/2026 (projeto ahattpqrjmhkzsmnbdzs),
-- conferido por md5(prosrc) no arquivo .md5.json ao lado.
--
-- NENHUM DADO REAL: só corpo de função.

CREATE OR REPLACE FUNCTION public.liberar_fidelizacao_caso(p_caso_id uuid, p_motivo text DEFAULT 'FIDELIZACAO_EXPIRADA'::text, p_autor text DEFAULT 'sistema_fidelizacao'::text)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_c record;
begin
  select * into v_c from public.casos where id = p_caso_id for update;
  if not found or v_c.operador_email is null then return false; end if;
  -- Fidelizacao de 10 dias: dentro do prazo o caso nao e solto por caminho
  -- nenhum. Devolve false (nao levanta excecao) para o lote seguir em frente.
  if v_c.giro_fidelizacao_ate is not null then
    -- Caso de giro: nao volta ao pool por rotina automatica. Ate a data da
    -- fidelizacao por exclusividade; depois dela, para preservar o responsavel
    -- ate que outro operador assuma pelo fluxo normal.
    return false;
  end if;

  if public.caso_dentro_prazo_fidelizacao(v_c.data_ultimo_acionamento) then return false; end if;
  update public.casos set operador_email=null, operador_nome=null, operador=null,
    caso_atualizado_por=p_autor, caso_atualizado_em=now()
  where id = p_caso_id;
  if v_c.aluno_id is not null then
    update public.alunos set responsavel_atual_email=null, responsavel_atual_nome=null
    where id = v_c.aluno_id;
  end if;
  insert into public.historico_operadores_alunos
    (chave_unificacao, nome_aluno, cpf_referencia, acao, operador_anterior_nome, operador_anterior_email, observacao, criado_em)
  values (v_c.chave_unificacao, v_c.nome, v_c.cpf, p_motivo, v_c.operador_nome, v_c.operador_email,
    'Fidelizacao expirada (ultimo acionamento '||coalesce(v_c.data_ultimo_acionamento::text,'nunca')||' + 10d). Caso LIVRE, sem atribuicao automatica. Responsavel anterior preservado.', now());
  return true;
end;
$function$;

-- casos_risco_perder e usuario_tem_visao_geral: corpos EXATOS de producao em
-- 12/11/2026, conferidos por md5 (fonte do card "risco de perder").
-- ATENCAO: email_usuario_logado abaixo e um DUBLE de infraestrutura (nao esta
-- no .md5.json): le o e-mail do JWT como o PostgREST. Nao e corpo de producao.
CREATE OR REPLACE FUNCTION public.email_usuario_logado()
 RETURNS text
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  select lower(coalesce(auth.jwt() ->> 'email', ''));
$function$;

CREATE OR REPLACE FUNCTION public.usuario_tem_visao_geral()
 RETURNS boolean
 LANGUAGE sql
 STABLE
 SET search_path TO 'public'
AS $function$
  select public.email_usuario_logado() in (
    'amanda.seibel@aelbra.com.br',
    'cobranca04@aelbra.com.br',
    'cobranca07@aelbra.com.br'
  );
$function$;

CREATE OR REPLACE FUNCTION public.casos_risco_perder(p_email text DEFAULT NULL::text)
 RETURNS TABLE(caso_id uuid, aluno_id uuid, operador_email text, data_ultimo_acionamento date, dias_parado integer, nunca_acionado boolean)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_jwt text := lower(coalesce(auth.jwt() ->> 'email',''));
  v_alvo text := nullif(lower(coalesce(p_email,'')),'');
begin
  -- Operador so enxerga a propria carteira; gestao/diretoria enxerga todas.
  if v_jwt <> '' and not (public.usuario_e_gestao() or public.usuario_tem_visao_geral()) then
    v_alvo := v_jwt;
  end if;

  return query
  select c.id, c.aluno_id, c.operador_email, c.data_ultimo_acionamento,
         case when c.data_ultimo_acionamento is null then null
              else (current_date - c.data_ultimo_acionamento)::int end,
         (c.data_ultimo_acionamento is null)
  from public.casos c
  where c.operador_email is not null
    -- Sem aluno nao ha o que acionar: o caso nao entra no card nem na lista.
    and c.aluno_id is not null
    and (v_alvo is null or lower(c.operador_email) = v_alvo)
    and not public.caso_dentro_prazo_fidelizacao(c.data_ultimo_acionamento)
    and not public.caso_protegido_redistribuicao(c.cpf_limpo, c.status_acionamento, c.nao_acionar,
          c.status_financeiro, c.valor_pago, c.quitado_em, c.valor_quitado)
    and not public.caso_encerrado_operacional(c.cpf_limpo, c.status_atual, c.status_acionamento,
          c.status_financeiro, c.status_jornada)
  order by (c.data_ultimo_acionamento is null) desc, c.data_ultimo_acionamento asc nulls first;
end;
$function$;

-- GRANTS REAIS DE PRODUCAO (12/11/2026): proacl = {postgres=X, authenticated=X,
-- service_role=X}, sem PUBLIC. Sem isto o teste de grants compara NULL com NULL
-- e nao prova nada.
REVOKE ALL ON FUNCTION public.liberar_fidelizacao_caso(uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.trg_impor_teto_operador() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.assumir_caso_livre(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.casos_risco_perder(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.liberar_fidelizacao_caso(uuid, text, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.trg_impor_teto_operador() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.assumir_caso_livre(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.casos_risco_perder(text) TO authenticated, service_role;
