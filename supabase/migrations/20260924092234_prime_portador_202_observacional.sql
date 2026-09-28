-- Portador 202 (REATIVA COBRANCA JUDICIAL): tornar a condicao juridica ATUAL
-- verificavel. Etapa OBSERVACIONAL -- nada aqui reativa titulo, muda situacao,
-- status, saldo, fila, Acoes Massivas, efetividade, acordo ou bordero.
--
-- POR QUE ISTO EXISTE. Em 01/09/2026, 262 titulos (R$ 2,4 mi, 60 alunos) foram
-- cancelados por estarem em cobranca judicial -- 183 pelo portador 202 e 79
-- pela marcacao do CRM. Hoje nao ha como saber se essa condicao ainda vale:
-- `public.juridico` esta VAZIA e `prime_portador_membro` so coletava 195 e 166.
-- Sem essa resposta, qualquer regra de reativacao decide no escuro.
--
-- A REGRA QUE GOVERNA TUDO AQUI (Amanda, 24/09/2026): "uma coleta incompleta,
-- erro de API ou falha de paginacao nunca pode transformar ausencia em 'nao
-- esta no juridico'". Por isso:
--
--     PRESENCA no 202  -> 'SIM' sempre, mesmo com snapshot parcial.
--                         Achar e achar; um snapshot pela metade que ACHOU o
--                         CPF ja provou a filiacao.
--     AUSENCIA no 202  -> 'NAO' SO com snapshot completo e valido.
--                         Caso contrario 'INDETERMINADO' -- nunca 'NAO'.
--
-- O 195 sozinho NAO autoriza nada: ele diz que o aluno esta na carteira de
-- cobranca, e a filiacao e por CPF com boleto aberto OU liquidado. O aluno pode
-- estar nos DOIS portadores ao mesmo tempo. A elegibilidade futura exigira
-- `esta no 195` E `nao esta no 202 em snapshot completo e valido`, mais as
-- demais travas -- e ela nao e criada nesta migration.
--
-- O MUTIRAO NAO E TOCADO de proposito. `prime_portador_mutirao` alterna entre
-- 166 e 195 em janelas de 3 minutos aos sabados; incluir um terceiro portador
-- ali roubaria janela dos outros dois e mudaria a cadencia de uma rotina que
-- hoje funciona. A coleta do 202 ganha disparo proprio.

-- 1) ESTADO DO SNAPSHOT: ele esta completo e confiavel?
--
-- `prime_sync_cursor.proximo_skip = 0` e o sinal de ciclo fechado que a Edge ja
-- grava (ela so remove as linhas do ciclo anterior quando termina a varredura).
-- Comparar o ciclo do cursor com o ciclo das linhas pega o caso em que a
-- varredura fechou mas a gravacao ficou para tras.
--
-- `cpfs` e sempre MENOR que `total_itens_api`: a API devolve uma linha por
-- MATRICULA e a Edge deduplica por CPF (no 195, 41.194 itens -> 20.318 CPFs).
-- Por isso a checagem de vazio e qualitativa, nunca uma igualdade.
create or replace function public.prime_portador_snapshot_estado(
  p_portador int,
  p_max_idade_horas int default 720
)
returns jsonb
language sql
stable
security definer
set search_path to 'public'
as $function$
  with cur as (
    select proximo_skip, total_itens, ciclo, atualizado_em
      from public.prime_sync_cursor where carrier_id = p_portador
  ),
  lin as (
    select count(*)::int cpfs, max(ciclo) ciclo_linhas, max(coletado_em) coletado_em
      from public.prime_portador_membro where portador = p_portador
  ),
  base as (
    select c.proximo_skip, c.total_itens, c.ciclo as ciclo_cursor, c.atualizado_em,
           coalesce(l.cpfs,0) as cpfs, l.ciclo_linhas, l.coletado_em,
           c.carrier_existe as tem_cursor
      from (select *, true as carrier_existe from cur) c
      full join lin l on true
  ),
  aval as (
    select b.*,
           case
             when b.tem_cursor is not true then 'SEM_COLETA'
             when coalesce(b.proximo_skip, 1) <> 0 then 'CICLO_INCOMPLETO'
             when b.ciclo_linhas is distinct from b.ciclo_cursor then 'CICLO_DESSINCRONIZADO'
             when coalesce(b.total_itens,0) > 0 and b.cpfs = 0 then 'VAZIO_INESPERADO'
             when b.atualizado_em is null then 'SEM_DATA'
             when b.atualizado_em < now() - make_interval(hours => greatest(p_max_idade_horas,1))
               then 'DESATUALIZADO'
             else 'OK'
           end as motivo
      from base b
  )
  select jsonb_build_object(
    'portador', p_portador,
    'valido', (a.motivo = 'OK'),
    'motivo', a.motivo,
    'ciclo', a.ciclo_cursor,
    'ciclo_linhas', a.ciclo_linhas,
    'cpfs', a.cpfs,
    'total_itens_api', a.total_itens,
    'concluido', (coalesce(a.proximo_skip, 1) = 0),
    'coletado_em', a.coletado_em,
    'atualizado_em', a.atualizado_em,
    'idade_horas', case when a.atualizado_em is null then null
                        else floor(extract(epoch from (now() - a.atualizado_em)) / 3600)::int end,
    'max_idade_horas', p_max_idade_horas
  )
  from aval a;
$function$;

grant execute on function public.prime_portador_snapshot_estado(int, int)
  to authenticated, service_role;

-- 2) A RESPOSTA DE TRES VALORES. Nunca booleana: 'NAO' e uma afirmacao forte e
-- so pode sair de um snapshot que se sabe completo.
-- A RESPOSTA DE TRES VALORES, e a ordem dela e a regra:
--   1. CPF ilegivel nao vira 'NAO' por descuido: vira INDETERMINADO;
--   2. PRESENCA no 202 vale mesmo com snapshot parcial -- achar e achar;
--   3. AUSENCIA so conclui 'NAO' com snapshot completo e valido.
-- (Estes comentarios ficam FORA do corpo de proposito: texto dentro de
--  $function$ entra no `prosrc` e faria o arquivo divergir do objeto aplicado
--  em producao -- foi exatamente o drift corrigido em 24/09/2026.)
create or replace function public.prime_aluno_no_juridico(p_cpf text)
returns text
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
declare
  v_cpf text := lpad(regexp_replace(coalesce(p_cpf,''), '\D', '', 'g'), 11, '0');
  v_estado jsonb;
begin
  if length(v_cpf) <> 11 or v_cpf !~ '^[0-9]{11}$' or v_cpf = '00000000000' then
    return 'INDETERMINADO';
  end if;

  if exists (
    select 1 from public.prime_portador_membro m
     where m.portador = 202
       and lpad(regexp_replace(coalesce(m.cpf,''), '\D', '', 'g'), 11, '0') = v_cpf
  ) then
    return 'SIM';
  end if;

  v_estado := public.prime_portador_snapshot_estado(202);
  if not coalesce((v_estado->>'valido')::boolean, false) then
    return 'INDETERMINADO';
  end if;

  return 'NAO';
end;
$function$;

grant execute on function public.prime_aluno_no_juridico(text)
  to authenticated, service_role;

-- 3) DISPARO DA COLETA. Mesma Edge, mesmo token, mesma logica de ciclo que
-- 166/195 -- a Edge ja aceita o portador por parametro, entao a varredura, o
-- dedupe por CPF e a limpeza do ciclo anterior sao literalmente os mesmos.
-- Restrita a gestao: e uma chamada externa, nao uma leitura.
create or replace function public.prime_portador_202_coletar(p_reiniciar boolean default false)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare v_url text; v_token text; v_req bigint; v_carga jsonb;
begin
  if not coalesce(public.usuario_e_gestao(), false)
     and coalesce(auth.role(),'') <> 'service_role' then
    raise exception 'Coleta do portador 202 e da gestao.' using errcode = '42501';
  end if;

  v_carga := public.sistema_sob_carga();
  if coalesce((v_carga->>'sob_carga')::boolean, false) then
    return jsonb_build_object('ok', false, 'motivo', 'SISTEMA_SOB_CARGA');
  end if;

  select decrypted_secret into v_url   from vault.decrypted_secrets where name='projeto_url';
  select decrypted_secret into v_token from vault.decrypted_secrets where name='prime_cadastro_token';
  if v_url is null or v_token is null then
    return jsonb_build_object('ok', false, 'motivo', 'SEGREDO_AUSENTE');
  end if;

  select net.http_post(
    url := rtrim(v_url,'/') || '/functions/v1/prime-portador',
    headers := jsonb_build_object('Content-Type','application/json','x-rotina-token', v_token),
    body := jsonb_build_object('portador', 202, 'reiniciar', coalesce(p_reiniciar,false)),
    timeout_milliseconds := 170000) into v_req;

  insert into public.auditoria (usuario, acao, tabela_afetada, registro_id, detalhes)
  values (coalesce(nullif(lower(auth.jwt() ->> 'email'),''), 'sistema'),
          'PRIME_PORTADOR_202_COLETA_DISPARADA', 'prime_portador_membro', null,
          jsonb_build_object('request_id', v_req, 'reiniciar', coalesce(p_reiniciar,false)));

  -- A varredura e paginada: uma chamada pode nao fechar o ciclo. Quem diz se o
  -- snapshot esta completo e `prime_portador_snapshot_estado(202)`, nunca o
  -- retorno deste disparo.
  return jsonb_build_object('ok', true, 'request_id', v_req,
                            'observacao', 'chamada enfileirada; confira prime_portador_snapshot_estado(202) ate motivo = OK');
end;
$function$;

grant execute on function public.prime_portador_202_coletar(boolean)
  to authenticated, service_role;
