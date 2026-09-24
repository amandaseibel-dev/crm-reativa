-- Observabilidade da coleta do portador 202: TODA chamada deixa rastro.
--
-- O FURO QUE ISTO FECHA (24/09/2026). A versao anterior gravava auditoria so
-- no caminho feliz: `SISTEMA_SOB_CARGA` e `SEGREDO_AUSENTE` davam `return`
-- antes do insert. Resultado pratico: a gestao disparou a coleta, nada
-- aconteceu, e nao havia como saber se a funcao tinha sido chamada e recusada
-- ou se nunca tinha sido chamada. Uma recusa silenciosa e indistinguivel de
-- uma omissao -- e foi exatamente esse o problema.
--
-- POR QUE A RECUSA POR PERMISSAO DEIXOU DE SER `raise exception`. Excecao em
-- PL/pgSQL desfaz a transacao inteira, e o insert de auditoria iria junto: era
-- impossivel auditar a tentativa negada mantendo o raise. A funcao passa a
-- devolver `{ok:false, motivo:'SEM_PERMISSAO'}`.
-- ISTO NAO AFROUXA NADA: quem nao e gestao continua sem disparar coleta
-- nenhuma -- a diferenca e que agora a tentativa fica registrada, que e o
-- comportamento desejado para uma funcao sensivel.
--
-- A PROTECAO DE CARGA NAO MUDA: `sistema_sob_carga()` continua sendo
-- consultada antes de qualquer chamada externa e continua abortando o disparo.
-- So passou a ser registrada.
--
-- NAO TOCA: Edge de varredura, mutirao de 166/195, permissoes (o GRANT e o
-- mesmo), titulos, alunos, saldo, cobranca, acordos. Nenhuma regra operacional.

-- Registro unico dos dois desfechos, para que nenhum caminho de saida possa
-- "esquecer" de auditar. Acoes separadas (_DISPARADA / _RECUSADA) para a busca
-- na auditoria ser direta.
create or replace function public._prime_portador_202_auditar(
  p_usuario text,
  p_resultado text,
  p_motivo text,
  p_request_id bigint,
  p_estado jsonb
)
returns void
language sql
security definer
set search_path to 'public'
as $function$
  insert into public.auditoria (usuario, acao, tabela_afetada, registro_id, detalhes)
  values (
    coalesce(nullif(btrim(p_usuario),''), '(sem usuario)'),
    case when p_resultado = 'DISPARADA'
         then 'PRIME_PORTADOR_202_COLETA_DISPARADA'
         else 'PRIME_PORTADOR_202_COLETA_RECUSADA' end,
    'prime_portador_membro',
    null,
    jsonb_build_object(
      'portador', 202,
      'resultado', p_resultado,
      'motivo', p_motivo,
      'request_id', p_request_id,
      'estado', p_estado,
      'em', now()
    )
  );
$function$;

revoke all on function public._prime_portador_202_auditar(text, text, text, bigint, jsonb) from public;

create or replace function public.prime_portador_202_coletar(p_reiniciar boolean default false)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_usuario text := coalesce(nullif(lower(auth.jwt() ->> 'email'), ''), nullif(auth.role(),''), 'sistema');
  v_gestao  boolean := coalesce(public.usuario_e_gestao(), false);
  v_service boolean := (coalesce(auth.role(),'') = 'service_role');
  v_url text; v_token text; v_req bigint; v_carga jsonb;
  v_estado jsonb;
  v_erro text;
begin
  -- Contexto comum a qualquer desfecho. NUNCA carrega segredo: apenas se o
  -- segredo EXISTE, nunca o valor.
  v_estado := jsonb_build_object(
    'snapshot_202', public.prime_portador_snapshot_estado(202),
    'reiniciar', coalesce(p_reiniciar, false)
  );

  -- 1) PERMISSAO. Continua restrita a gestao/service_role; o que mudou e que a
  --    tentativa negada passa a ficar registrada (ver cabecalho).
  if not v_gestao and not v_service then
    perform public._prime_portador_202_auditar(
      v_usuario, 'RECUSADA', 'SEM_PERMISSAO', null,
      v_estado || jsonb_build_object('role', coalesce(auth.role(),'(sem role)')));
    return jsonb_build_object('ok', false, 'motivo', 'SEM_PERMISSAO',
      'observacao', 'a coleta do portador 202 e da gestao financeira');
  end if;

  -- 2) CARGA. Regra inalterada -- so passou a ser auditada.
  v_carga := public.sistema_sob_carga();
  if coalesce((v_carga->>'sob_carga')::boolean, false) then
    perform public._prime_portador_202_auditar(
      v_usuario, 'RECUSADA', 'SISTEMA_SOB_CARGA', null,
      v_estado || jsonb_build_object('carga', v_carga));
    return jsonb_build_object('ok', false, 'motivo', 'SISTEMA_SOB_CARGA', 'carga', v_carga);
  end if;

  -- 3) SEGREDOS. Registra QUAIS faltam, nunca o conteudo.
  select decrypted_secret into v_url   from vault.decrypted_secrets where name = 'projeto_url';
  select decrypted_secret into v_token from vault.decrypted_secrets where name = 'prime_cadastro_token';
  if v_url is null or v_token is null then
    perform public._prime_portador_202_auditar(
      v_usuario, 'RECUSADA', 'SEGREDO_AUSENTE', null,
      v_estado || jsonb_build_object('tem_projeto_url', v_url is not null,
                                     'tem_prime_cadastro_token', v_token is not null));
    return jsonb_build_object('ok', false, 'motivo', 'SEGREDO_AUSENTE',
      'tem_projeto_url', v_url is not null, 'tem_prime_cadastro_token', v_token is not null);
  end if;

  -- 4) DISPARO. `net.http_post` apenas ENFILEIRA: falha de enfileiramento cai
  --    aqui; falha da chamada em si aparece depois em `net._http_response`, e e
  --    por isso que o request_id vai para a auditoria.
  begin
    select net.http_post(
      url := rtrim(v_url,'/') || '/functions/v1/prime-portador',
      headers := jsonb_build_object('Content-Type','application/json','x-rotina-token', v_token),
      body := jsonb_build_object('portador', 202, 'reiniciar', coalesce(p_reiniciar,false)),
      timeout_milliseconds := 170000) into v_req;
  exception when others then
    v_erro := sqlerrm;
    perform public._prime_portador_202_auditar(
      v_usuario, 'RECUSADA', 'FALHA_DISPARO_HTTP', null,
      v_estado || jsonb_build_object('erro', v_erro, 'sqlstate', sqlstate));
    return jsonb_build_object('ok', false, 'motivo', 'FALHA_DISPARO_HTTP', 'erro', v_erro);
  end;

  if v_req is null then
    perform public._prime_portador_202_auditar(
      v_usuario, 'RECUSADA', 'FALHA_DISPARO_HTTP', null,
      v_estado || jsonb_build_object('erro', 'net.http_post devolveu null'));
    return jsonb_build_object('ok', false, 'motivo', 'FALHA_DISPARO_HTTP',
      'erro', 'net.http_post devolveu null');
  end if;

  perform public._prime_portador_202_auditar(v_usuario, 'DISPARADA', null, v_req, v_estado);

  -- A varredura e paginada: uma chamada pode nao fechar o ciclo. Quem diz se o
  -- snapshot esta completo e `prime_portador_snapshot_estado(202)`, nunca este
  -- retorno.
  return jsonb_build_object('ok', true, 'motivo', null, 'request_id', v_req,
    'observacao', 'chamada enfileirada; confira prime_portador_snapshot_estado(202) ate motivo = OK');
end;
$function$;

grant execute on function public.prime_portador_202_coletar(boolean)
  to authenticated, service_role;
