-- Termo rejeitado: avisar quem ENVIOU o termo, e dizer o MOTIVO no aviso
-- ---------------------------------------------------------------------------
-- Pedido da Amanda (2026-09-04): "notificar o operador quando o termo for
-- rejeitado". O aviso já existia (sistema_retorno_termo, desde 07/08), mas com
-- dois furos medidos em produção no próprio dia 04/09:
--
--   1) ia só para o RESPONSÁVEL ATUAL do aluno. Quando o termo foi enviado por
--      outro operador (2 dos 7 rejeitados do dia: Aline e Agnaldo), quem enviou
--      não ficava sabendo — e o badge "termos rejeitados" do menu, que conta
--      por operador_email, acendia para ele sem nenhuma mensagem explicando.
--   2) a mensagem dizia "verifique o motivo e reenvie" sem trazer o motivo.
--      O operador tinha de abrir a ficha para descobrir o que corrigir.
--
-- Agora: na rejeição, o responsável E o operador que enviou (quando são
-- pessoas diferentes) recebem o aviso, e o texto traz o motivo da ADM. A
-- aprovação continua indo só ao responsável, que é quem libera o acordo.
--
-- A função ganha o parâmetro p_motivo. Como Postgres não deixa duas
-- assinaturas que casem com a mesma chamada de 5 argumentos, a antiga é
-- removida e a nova nasce com default: quem chama com 5 argumentos continua
-- funcionando. Únicos chamadores em prod: validar_assinatura_termo e
-- termo_devolver_ao_operador (ambos redefinidos abaixo para passar o motivo).

drop function if exists public.sistema_retorno_termo(uuid, text, text, text, text);

create or replace function public.sistema_retorno_termo(
  p_aluno_id uuid,
  p_status text,
  p_status_acionamento text,
  p_operador_email text default null,
  p_operador_nome text default null,
  p_motivo text default null
)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'internal'
as $function$
declare
  v_resp text; v_resp_nome text; v_nome_aluno text; v_cpf text;
  v_rejeitado boolean := (coalesce(p_status,'') ilike '%rejeit%'
                          or coalesce(p_status_acionamento,'') ilike '%rejeit%'
                          or coalesce(p_status,'') ilike '%recus%');
  v_motivo text := nullif(trim(coalesce(p_motivo,'')), '');
  v_op text := lower(nullif(trim(coalesce(p_operador_email,'')), ''));
  v_op_nome text := coalesce(p_operador_nome, p_operador_email);
  v_tipo text; v_titulo text; v_msg_base text;
  v_avisados text[] := '{}';
begin
  select responsavel_atual_email, responsavel_atual_nome, coalesce(nome_aluno,nome), cpf
    into v_resp, v_resp_nome, v_nome_aluno, v_cpf
  from public.alunos where id = p_aluno_id;

  update public.alunos
     set status_jornada = p_status, status_atual = p_status, nivel_criticidade = 'URGENTE',
         status_acionamento = coalesce(p_status_acionamento, p_status), data_ultimo_acionamento = now()
   where id = p_aluno_id;

  if v_rejeitado then
    v_tipo := 'TERMO_REJEITADO';
    v_titulo := '❌ Termo rejeitado';
    v_msg_base := 'O termo' || coalesce(' de ' || v_nome_aluno, '') || ' foi REJEITADO pela validação. '
      || case when v_motivo is not null then 'Motivo: ' || v_motivo || '. ' else '' end
      || 'Corrija e reenvie o termo pela ficha do aluno.';
  else
    v_tipo := 'TERMO_APROVADO';
    v_titulo := '✅ Termo aprovado!';
    v_msg_base := 'O termo' || coalesce(' de ' || v_nome_aluno, '') || ' foi APROVADO. Libere o acordo do aluno.';
  end if;

  if coalesce(v_resp,'') <> '' then
    insert into public.aluno_movimentacoes
      (aluno_id, tipo, descricao, status_novo, registrado_por_nome, registrado_por_email, registrado_em)
    values
      (p_aluno_id::text, 'RETORNO_TERMO',
       'Termo anexado (por ' || coalesce(v_op_nome, 'operador') || ') e retornado ao responsavel '
         || coalesce(v_resp_nome, v_resp) || '. '
         || case when v_rejeitado
                 then 'Resultado: REJEITADO.' || coalesce(' Motivo: ' || v_motivo || '.', '')
                 else 'Pendencia: liberar acordo.' end,
       p_status, coalesce(v_op_nome, 'sistema'), coalesce(p_operador_email, 'sistema'), now());

    insert into public.notificacoes
      (usuario_destino_email, usuario_destino_nome, tipo, titulo, mensagem, aluno_id, url_destino, lida, criado_em)
    values
      (lower(v_resp), v_resp_nome, v_tipo, v_titulo,
       v_msg_base || case when v_rejeitado and v_op is not null and v_op <> lower(v_resp)
                          then ' (termo enviado por ' || v_op_nome || ')' else '' end,
       p_aluno_id::text, '/painel-carteira', false, now());
    v_avisados := array[lower(v_resp)];

    -- Quem enviou o termo é outra pessoa: também precisa saber que voltou,
    -- e com quem o caso está.
    if v_rejeitado and v_op is not null and v_op <> lower(v_resp) then
      insert into public.notificacoes
        (usuario_destino_email, usuario_destino_nome, tipo, titulo, mensagem, aluno_id, url_destino, lida, criado_em)
      values
        (v_op, v_op_nome, v_tipo, v_titulo,
         v_msg_base || ' (o caso está com ' || coalesce(v_resp_nome, v_resp) || ')',
         p_aluno_id::text, '/painel-carteira', false, now());
      v_avisados := v_avisados || v_op;
    end if;

  elsif v_op is not null then
    perform internal.set_resp_aluno(p_aluno_id, p_operador_email, coalesce(p_operador_nome, p_operador_email),
      'ALTERACAO_OPERADOR',
      'Retorno de termo (aluno sem responsavel) -> ' || v_op || '. Origem: retorno_termo.', 'sistema', 'sistema');
    insert into public.notificacoes
      (usuario_destino_email, usuario_destino_nome, tipo, titulo, mensagem, aluno_id, url_destino, lida, criado_em)
    values
      (v_op, v_op_nome, v_tipo, v_titulo, v_msg_base || ' (caso ficou com você)',
       p_aluno_id::text, '/painel-carteira', false, now());
    v_avisados := array[v_op];
  end if;

  return jsonb_build_object('ok', true, 'aluno_id', p_aluno_id, 'rejeitado', v_rejeitado,
    'responsavel', coalesce(nullif(v_resp,''), v_op), 'avisados', to_jsonb(v_avisados));
end;
$function$;

-- Só as funções SECURITY DEFINER da fila chamam esta; o cliente nunca chama direto.
revoke all on function public.sistema_retorno_termo(uuid, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.sistema_retorno_termo(uuid, text, text, text, text, text) to service_role;

-- validar_assinatura_termo: idêntica à de 20260812180000, só passa o motivo. --
create or replace function public.validar_assinatura_termo(
    p_termo_id uuid,
    p_decisao text,
    p_observacao text default null::text,
    p_motivo text default null::text,
    p_abrir_proximo boolean default false)
  returns jsonb
  language plpgsql
  security definer
  set search_path to 'public', 'internal'
as $function$
declare
  v_termo public.termos_acordo%rowtype;
  v_ator text; v_decisao text := upper(coalesce(p_decisao, ''));
  v_novo_status text; v_obs text; v_prox jsonb := null; v_aluno_uuid uuid;
  v_eh_gov boolean;
begin
  if not public.usuario_e_gestao() then
    return jsonb_build_object('ok', false, 'erro', 'acesso_negado');
  end if;
  v_ator := coalesce(public.app_email(), 'ADM');
  if v_decisao not in ('APROVAR', 'REJEITAR') then
    return jsonb_build_object('ok', false, 'erro', 'decisao_invalida');
  end if;
  select * into v_termo from public.termos_acordo where id = p_termo_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'erro', 'termo_nao_encontrado');
  end if;
  -- idempotência: clique duplo / dois ADMs
  if v_decisao = 'APROVAR' and v_termo.status = 'TERMO_RECEBIDO_LIBERADO' then
    if p_abrir_proximo then v_prox := public._termo_proximo_pendente(p_termo_id); end if;
    return jsonb_build_object('ok', true, 'ja_processado', true, 'status', v_termo.status, 'proximo', v_prox);
  end if;
  if v_decisao = 'REJEITAR' and v_termo.status = 'TERMO_REJEITADO' then
    if p_abrir_proximo then v_prox := public._termo_proximo_pendente(p_termo_id); end if;
    return jsonb_build_object('ok', true, 'ja_processado', true, 'status', v_termo.status, 'proximo', v_prox);
  end if;

  v_eh_gov := (v_termo.status = 'TERMO_LIBERADO_AUTOMATICO_GOV');

  if v_eh_gov and coalesce(v_termo.validado_por, '') <> 'AUTOMATICO_GOV_BR' then
    return jsonb_build_object('ok', false, 'erro', 'status_invalido', 'status', v_termo.status);
  end if;
  if v_termo.status not in ('TERMO_ENVIADO_ADM', 'TERMO_LIBERADO_AUTOMATICO_GOV') then
    return jsonb_build_object('ok', false, 'erro', 'status_invalido', 'status', v_termo.status);
  end if;

  if v_decisao = 'APROVAR' then
    v_novo_status := 'TERMO_RECEBIDO_LIBERADO';
    v_obs := coalesce(nullif(trim(p_observacao), ''),
                      case when v_eh_gov then 'Documento gov.br conferido e liberado pela ADM.'
                           else 'Assinatura validada pela ADM.' end);
  else
    if coalesce(nullif(trim(p_motivo), ''), '') = '' then
      return jsonb_build_object('ok', false, 'erro', 'motivo_obrigatorio');
    end if;
    v_novo_status := 'TERMO_REJEITADO'; v_obs := trim(p_motivo);
  end if;
  update public.termos_acordo
     set status = v_novo_status, observacao_adm = v_obs, validado_por = v_ator,
         validado_em = now(), atualizado_em = now()
   where id = p_termo_id;
  begin v_aluno_uuid := nullif(v_termo.aluno_id, '')::uuid;
  exception when others then v_aluno_uuid := null; end;
  if v_aluno_uuid is not null then
    perform public.sistema_retorno_termo(v_aluno_uuid, v_novo_status, v_novo_status,
      v_termo.operador_email, coalesce(v_termo.operador_nome, v_termo.operador_email),
      case when v_decisao = 'REJEITAR' then v_obs else null end);
  end if;
  if p_abrir_proximo then v_prox := public._termo_proximo_pendente(p_termo_id); end if;
  return jsonb_build_object('ok', true, 'status', v_novo_status, 'validado_por', v_ator, 'proximo', v_prox);
end; $function$;

-- termo_devolver_ao_operador: idêntica à de 20260904150000, só passa o motivo.
create or replace function public.termo_devolver_ao_operador(
  p_termo_id uuid,
  p_motivo text
)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'internal'
as $$
declare
  v_termo public.termos_acordo%rowtype;
  v_motivo text := nullif(trim(coalesce(p_motivo,'')), '');
  v_ator text;
  v_aluno_uuid uuid;
begin
  if not public.usuario_e_gestao() then
    return jsonb_build_object('ok', false, 'erro', 'acesso_negado');
  end if;
  if v_motivo is null then
    return jsonb_build_object('ok', false, 'erro', 'motivo_obrigatorio');
  end if;
  v_ator := coalesce(nullif(public.app_email(), ''), 'ADM');

  select * into v_termo from public.termos_acordo where id = p_termo_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'erro', 'termo_nao_encontrado');
  end if;
  if v_termo.status = 'TERMO_REJEITADO' then
    return jsonb_build_object('ok', true, 'ja_processado', true, 'status', v_termo.status);
  end if;
  if v_termo.status not in ('TERMO_RECEBIDO_LIBERADO','TERMO_LIBERADO_AUTOMATICO_GOV') then
    return jsonb_build_object('ok', false, 'erro', 'status_invalido', 'status', v_termo.status);
  end if;
  if v_termo.etapa_assinatura = 'COMPLETO' then
    return jsonb_build_object('ok', false, 'erro', 'assinatura_concluida');
  end if;

  update public.termos_acordo
     set status = 'TERMO_REJEITADO',
         observacao_adm = v_motivo,
         validado_por = v_ator,
         validado_em = now(),
         etapa_assinatura = 'NAO_APLICAVEL',
         assinatura_enviada_em = null,
         assinatura_enviada_por = null,
         dispensa_motivo = null,
         dispensa_detalhe = null,
         dispensado_em = null,
         dispensado_por = null,
         atualizado_em = now()
   where id = p_termo_id;

  begin
    v_aluno_uuid := nullif(v_termo.aluno_id, '')::uuid;
  exception when others then
    v_aluno_uuid := null;
  end;
  if v_aluno_uuid is not null then
    perform public.sistema_retorno_termo(v_aluno_uuid, 'TERMO_REJEITADO', 'TERMO_REJEITADO',
      v_termo.operador_email, coalesce(v_termo.operador_nome, v_termo.operador_email), v_motivo);
  end if;

  return jsonb_build_object('ok', true, 'status', 'TERMO_REJEITADO', 'validado_por', v_ator);
end;
$$;
