-- ROLLBACK da E5: devolve `cancelar_acordo_ficha` ao corpo de producao de
-- 26/10/2026, md5(prosrc) `130665ad5be7b222b74875ebcc767719` (aplicado como
-- parte da versao 20260925123852).
--
-- Reverter a E5 e seguro em qualquer momento: ela nunca escreveu em dado. O
-- unico efeito de voltar atras e a tela parar de distinguir os tres desfechos
-- e as linhas de `auditoria` com acao ACORDO_CANCELADO_COM_MENSALIDADE_QUITADA
-- pararem de ser gravadas. As linhas ja gravadas FICAM -- auditoria nao se
-- apaga, e elas sao o registro de inconsistencia que a E6 vai consumir.
--
-- Nada a desfazer em `acordos`, `acordos_titulos`, `acordo_titulo_vinculo`,
-- `parcelas`, `pagamentos` ou `baixas_pagamento`.

create or replace function public.cancelar_acordo_ficha(p_acordo_id uuid)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
set statement_timeout to '60s'
as $function$
declare
  v_agora    timestamptz := now();
  v_acordo   public.acordos%rowtype;
  v_vinculos int := 0;
  v_parcelas int := 0;
begin
  if not public.crm_usuario_pode_quitar_baixar() then
    raise exception 'Cancelar acordo e exclusivo da gestao financeira.' using errcode = '42501';
  end if;

  select * into v_acordo from public.acordos where id = p_acordo_id for update;
  if not found then
    raise exception 'Acordo nao encontrado.' using errcode = 'P0001';
  end if;
  if upper(coalesce(v_acordo.status, '')) in ('CANCELADO', 'CANCELADA') then
    raise exception 'Este acordo ja esta cancelado.' using errcode = 'P0001';
  end if;

  if exists (select 1 from public.parcelas where acordo_id = p_acordo_id and upper(coalesce(status, '')) = 'PAGO') then
    raise exception 'Esse acordo ja tem parcela paga -- nao da pra cancelar (protege o historico financeiro). Se foi um erro, fale com quem confirmou o pagamento antes de mexer.' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.baixas_pagamento where acordo_id = p_acordo_id and devolvido_em is null) then
    raise exception 'Esse acordo ja tem alguma baixa/pagamento registrado -- nao da pra cancelar por aqui.' using errcode = 'P0001';
  end if;

  -- Quem decide o destino de cada mensalidade e titulo_reavaliar, disparado
  -- pelo gatilho do UPDATE de status abaixo (trg_acordo_status_reavalia_titulos).
  -- Como as travas acima garantem que este acordo nunca recebeu pagamento, a
  -- mensalidade volta para ABERTO e fica livre para um acordo novo -- a menos
  -- que outro acordo da cadeia dela tenha recebido dinheiro (re-acordo), caso
  -- em que continua NEGOCIADA e a divida e o saldo residual (25/09/2026). Por
  -- isso o status do acordo muda PRIMEIRO: titulo_reavaliar precisa ver o
  -- acordo ja CANCELADO. So depois o vinculo e' desativado -- nunca apagado --
  -- para a cadeia mensalidade->negociacao->acordo continuar inteira na tela e
  -- na auditoria.
  update public.acordos
     set status = 'CANCELADO', saldo = 0, atualizado_em = v_agora
   where id = p_acordo_id;

  update public.acordo_titulo_vinculo
     set ativo = false
   where acordo_id = p_acordo_id and coalesce(ativo, true);
  get diagnostics v_vinculos = row_count;

  update public.parcelas
     set status = 'CANCELADA', atualizado_em = v_agora
   where acordo_id = p_acordo_id
     and upper(coalesce(status, '')) <> 'PAGO';
  get diagnostics v_parcelas = row_count;

  if v_acordo.aluno_id is not null then
    perform public.liberar_caso_por_evento(v_acordo.aluno_id, 'CANCELADO');
  end if;

  return jsonb_build_object(
    'ok', true,
    'acordo_id', p_acordo_id,
    'vinculos_desativados', v_vinculos,
    'parcelas_canceladas', v_parcelas
  );
end;
$function$;
