-- Honorário de UMA parcela, na mão.
--
-- Amanda, 26/08/2026: "eu consigo inserir manualmente o valor do honorário na
-- parcela?" e "os antigos vou corrigindo à medida que os pagamentos vão
-- entrando".
--
-- O QUE JÁ DAVA E O QUE NÃO DAVA. Dava informar o honorário do ACORDO INTEIRO
-- (acordo_definir_honorarios), que rateia proporcionalmente entre as parcelas
-- em aberto. E dava digitar o honorário na hora de BAIXAR a parcela. O que não
-- dava era o caso do meio, que é justamente o dela: acordo antigo em que cada
-- parcela tem um honorário próprio, corrigido uma a uma conforme o pagamento
-- entra -- sem baixar nada e sem que o rateio automático desmanche o que já foi
-- ajustado à mão nas outras.
--
-- POR QUE NÃO MEXE NO TOTAL DO ACORDO. `acordos.honorarios_valor` é o
-- COMBINADO; a soma das parcelas é o que está previsto entrar. Enquanto o
-- ajuste manual está no meio do caminho os dois números divergem de verdade, e
-- a ficha mostra os dois lado a lado. Sobrescrever o combinado aqui apagaria a
-- única pista de que ainda falta parcela para ajustar.
--
-- QUEM PODE: a mesma porta de quitar, baixar e lançar acordo -- Amanda,
-- Fernanda e Amanda ADM.

create or replace function public.parcela_definir_honorario(
  p_parcela_id uuid,
  p_valor numeric,
  p_motivo text default null
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_email    text := lower(coalesce(auth.jwt() ->> 'email', ''));
  v_parcela  public.parcelas%rowtype;
  v_acordo   public.acordos%rowtype;
  v_antigo   numeric;
  v_novo     numeric;
  v_soma     numeric;
begin
  if not public.crm_usuario_pode_quitar_baixar() then
    raise exception 'SEM_PERMISSAO: seu usuário não pode alterar honorários.';
  end if;

  select * into v_parcela from public.parcelas where id = p_parcela_id for update;
  if not found then
    raise exception 'PARCELA_NAO_ENCONTRADA';
  end if;

  select * into v_acordo from public.acordos where id = v_parcela.acordo_id;
  if not found then
    raise exception 'ACORDO_NAO_ENCONTRADO';
  end if;

  -- Acordo encerrado não recebe ajuste: espelha acordo_permite_acao_financeira.
  if v_acordo.status <> 'ATIVO' then
    raise exception 'ACORDO_NAO_ATIVO: este acordo está % -- honorário só se informa em acordo ativo.', v_acordo.status;
  end if;

  if coalesce(v_parcela.status,'') = 'CANCELADA' then
    raise exception 'PARCELA_CANCELADA: parcela cancelada não recebe honorário.';
  end if;

  v_novo := round(coalesce(p_valor, 0), 2);
  if v_novo < 0 then
    raise exception 'HONORARIO_NEGATIVO: informe zero ou mais.';
  end if;

  if v_novo > round(coalesce(v_parcela.valor, 0), 2) then
    raise exception 'HONORARIO_MAIOR_QUE_A_PARCELA: % é mais do que a parcela inteira (%). Confira o valor.',
      to_char(v_novo,'FM999G999G990D00'), to_char(coalesce(v_parcela.valor,0),'FM999G999G990D00');
  end if;

  v_antigo := round(coalesce(v_parcela.honorarios, 0), 2);

  update public.parcelas set honorarios = v_novo where id = p_parcela_id;

  select round(coalesce(sum(honorarios),0),2) into v_soma
  from public.parcelas
  where acordo_id = v_parcela.acordo_id and coalesce(status,'') <> 'CANCELADA';

  -- Fica no histórico do aluno: honorário é o número pelo qual o operador é
  -- cobrado, então mudança na mão tem de ter dono, data e motivo.
  if v_acordo.aluno_id is not null then
    insert into public.aluno_movimentacoes (
      aluno_id, tipo, descricao, registrado_por_email, registrado_em, valor_movimentacao
    ) values (
      v_acordo.aluno_id::text,
      'HONORARIO_INFORMADO',
      concat_ws(' ',
        'Honorário da parcela', coalesce(v_parcela.numero::text,'?'),
        'ajustado de', to_char(v_antigo,'FM999G999G990D00'),
        'para', to_char(v_novo,'FM999G999G990D00') || '.',
        'Soma das parcelas agora:', to_char(v_soma,'FM999G999G990D00') || '.',
        nullif(btrim(coalesce(p_motivo,'')),'')
      ),
      v_email, now(), v_novo
    );
  end if;

  return jsonb_build_object(
    'ok', true,
    'parcela_id', p_parcela_id,
    'acordo_id', v_parcela.acordo_id,
    'honorario_anterior', v_antigo,
    'honorario', v_novo,
    'soma_das_parcelas', v_soma,
    'honorario_do_acordo', round(coalesce(v_acordo.honorarios_valor,0),2)
  );
end;
$function$;

revoke all on function public.parcela_definir_honorario(uuid, numeric, text) from public;
grant execute on function public.parcela_definir_honorario(uuid, numeric, text) to authenticated;

comment on function public.parcela_definir_honorario(uuid, numeric, text) is
  'Ajusta o honorario de UMA parcela, sem baixar e sem refazer o rateio das outras -- o caso de corrigir acordo antigo uma parcela por vez. Nao mexe em acordos.honorarios_valor de proposito: o combinado e a soma prevista sao numeros diferentes e a divergencia entre eles e a pista de que ainda falta ajustar. Restrito a crm_usuario_pode_quitar_baixar().';
