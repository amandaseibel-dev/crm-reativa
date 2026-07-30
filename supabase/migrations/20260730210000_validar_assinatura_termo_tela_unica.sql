-- Validação da assinatura do termo em TELA ÚNICA (hotfix operacional).
-- ---------------------------------------------------------------------------
-- Contexto: após o bloqueio de duas telas/abas, a ADM precisava abrir o PDF
-- assinado em outra aba (window.open) e voltar para aprovar/rejeitar. Este RPC
-- centraliza a decisão (antes era UPDATE direto do frontend) para torná-la:
--   * autorizada (só gestão/ADM),
--   * atômica (lock da linha -> impede dupla decisão concorrente),
--   * idempotente (clique duplo não gera 2 avisos / 2 históricos),
--   * auditável (validado_por / validado_em + trigger de aviso já existente),
--   * capaz de devolver o próximo termo pendente (menos cliques).
--
-- NÃO cria acordo, NÃO confirma pagamento, NÃO altera saldo, NÃO faz baixa.
-- A notificação ao operador continua vindo do trigger trg_notif_termo_liberado
-- (disparado pela mudança de status para TERMO_RECEBIDO_LIBERADO). O retorno do
-- caso ao operador segue via sistema_retorno_termo (mesmo comportamento atual).

-- Próximo termo pendente (menor criado_em), excluindo o recém-decidido.
create or replace function public._termo_proximo_pendente(p_excluir uuid)
returns jsonb
language sql
security definer
set search_path to 'public'
stable
as $$
  select coalesce(
    (select jsonb_build_object(
        'id', id,
        'aluno_nome', aluno_nome,
        'aluno_id', aluno_id,
        'operador_nome', operador_nome,
        'criado_em', criado_em)
     from public.termos_acordo
     where status = 'TERMO_ENVIADO_ADM'
       and id <> coalesce(p_excluir, '00000000-0000-0000-0000-000000000000'::uuid)
     order by criado_em asc
     limit 1),
    'null'::jsonb);
$$;

create or replace function public.validar_assinatura_termo(
  p_termo_id uuid,
  p_decisao text,                       -- 'APROVAR' | 'REJEITAR'
  p_observacao text default null,       -- observação da ADM (aprovação)
  p_motivo text default null,           -- motivo obrigatório (rejeição)
  p_abrir_proximo boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path to 'public', 'internal'
as $$
declare
  v_termo public.termos_acordo%rowtype;
  v_ator text;
  v_decisao text := upper(coalesce(p_decisao, ''));
  v_novo_status text;
  v_obs text;
  v_prox jsonb := null;
  v_aluno_uuid uuid;
begin
  -- Permissão: só gestão/ADM. SECURITY DEFINER bypassa RLS, então a checagem
  -- de perfil é feita aqui explicitamente.
  if not public.usuario_e_gestao() then
    return jsonb_build_object('ok', false, 'erro', 'acesso_negado');
  end if;
  v_ator := coalesce(public.app_email(), 'ADM');

  if v_decisao not in ('APROVAR', 'REJEITAR') then
    return jsonb_build_object('ok', false, 'erro', 'decisao_invalida');
  end if;

  -- Bloqueio atômico: serializa duas ADMs decidindo o MESMO termo.
  select * into v_termo from public.termos_acordo where id = p_termo_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'erro', 'termo_nao_encontrado');
  end if;

  -- Idempotência: já decidido no mesmo sentido -> não repete efeitos (nem aviso,
  -- nem histórico), apenas confirma e devolve o próximo, se pedido.
  if v_decisao = 'APROVAR' and v_termo.status = 'TERMO_RECEBIDO_LIBERADO' then
    if p_abrir_proximo then v_prox := public._termo_proximo_pendente(p_termo_id); end if;
    return jsonb_build_object('ok', true, 'ja_processado', true, 'status', v_termo.status, 'proximo', v_prox);
  end if;
  if v_decisao = 'REJEITAR' and v_termo.status = 'TERMO_REJEITADO' then
    if p_abrir_proximo then v_prox := public._termo_proximo_pendente(p_termo_id); end if;
    return jsonb_build_object('ok', true, 'ja_processado', true, 'status', v_termo.status, 'proximo', v_prox);
  end if;

  -- Só termos pendentes de validação podem ser decididos (impede reverter uma
  -- rejeição em aprovação sem novo envio, e vice-versa).
  if v_termo.status <> 'TERMO_ENVIADO_ADM' then
    return jsonb_build_object('ok', false, 'erro', 'status_invalido', 'status', v_termo.status);
  end if;

  if v_decisao = 'APROVAR' then
    v_novo_status := 'TERMO_RECEBIDO_LIBERADO';
    v_obs := coalesce(nullif(trim(p_observacao), ''), 'Assinatura validada pela ADM.');
  else
    if coalesce(nullif(trim(p_motivo), ''), '') = '' then
      return jsonb_build_object('ok', false, 'erro', 'motivo_obrigatorio');
    end if;
    v_novo_status := 'TERMO_REJEITADO';
    v_obs := trim(p_motivo);
  end if;

  -- A mudança de status para LIBERADO dispara trg_notif_termo_liberado (aviso +
  -- termo_liberacao_avisos + aluno_movimentacoes). Preserva o documento (não
  -- toca em arquivo_url). Rejeição não apaga arquivo.
  update public.termos_acordo
     set status = v_novo_status,
         observacao_adm = v_obs,
         validado_por = v_ator,
         validado_em = now(),
         atualizado_em = now()
   where id = p_termo_id;

  -- Devolve o caso ao operador que enviou (status do aluno + responsável),
  -- exatamente como o fluxo atual fazia após o UPDATE direto.
  begin
    v_aluno_uuid := nullif(v_termo.aluno_id, '')::uuid;
  exception when others then
    v_aluno_uuid := null;
  end;
  if v_aluno_uuid is not null then
    perform public.sistema_retorno_termo(
      v_aluno_uuid, v_novo_status, v_novo_status,
      v_termo.operador_email, coalesce(v_termo.operador_nome, v_termo.operador_email));
  end if;

  if p_abrir_proximo then v_prox := public._termo_proximo_pendente(p_termo_id); end if;

  return jsonb_build_object(
    'ok', true,
    'status', v_novo_status,
    'validado_por', v_ator,
    'proximo', v_prox);
end;
$$;

revoke all on function public.validar_assinatura_termo(uuid, text, text, text, boolean) from public;
grant execute on function public.validar_assinatura_termo(uuid, text, text, text, boolean) to authenticated;
revoke all on function public._termo_proximo_pendente(uuid) from public;
grant execute on function public._termo_proximo_pendente(uuid) to authenticated;
