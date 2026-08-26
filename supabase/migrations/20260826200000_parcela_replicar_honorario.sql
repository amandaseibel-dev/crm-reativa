-- Replicar o honorário de uma parcela nas demais do mesmo acordo.
--
-- Amanda, 26/08/2026: "não podemos colocar um botão de replicar honorários?"
--
-- POR QUE NÃO SERVE O QUE JÁ EXISTE. Há duas formas de informar honorário hoje
-- e nenhuma cobre este caso:
--
--   acordo_definir_honorarios  -> recebe o TOTAL do acordo e RATEIA pelo valor
--                                 de cada parcela. Serve quando se sabe o total.
--   parcela_definir_honorario  -> uma parcela por vez. Num acordo de 6x com
--                                 honorário igual em todas, é digitar o mesmo
--                                 número seis vezes.
--
-- Este é o caso do meio: sabe-se quanto é POR PARCELA, e é o mesmo em todas.
--
-- O QUE ELE FAZ. Pega o honorário da parcela de origem e grava o MESMO valor
-- nas outras parcelas em aberto do acordo. Não rateia, não divide: replica.
--
-- O QUE ELE NÃO TOCA, de propósito:
--   - parcela PAGA -- o honorário dela é fato consumado, não previsão;
--   - parcela CANCELADA;
--   - parcela onde o valor não caberia (honorário maior que a própria parcela).
--     Essa é pulada e devolvida na resposta, em vez de derrubar a operação
--     inteira -- assim o que dá para fazer é feito e o que não dá aparece.
--
-- Também não mexe em `acordos.honorarios_valor`, pelo mesmo motivo de
-- parcela_definir_honorario: o combinado do acordo e a soma prevista são
-- números diferentes, e a divergência entre eles é a pista de que ainda falta
-- ajustar alguma coisa.

create or replace function public.parcela_replicar_honorario(
  p_parcela_id uuid,
  p_motivo text default null
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_email     text := lower(coalesce(auth.jwt() ->> 'email', ''));
  v_origem    public.parcelas%rowtype;
  v_acordo    public.acordos%rowtype;
  v_valor     numeric;
  v_alteradas int := 0;
  v_puladas   jsonb := '[]'::jsonb;
  v_p         record;
  v_soma      numeric;
begin
  if not public.crm_usuario_pode_quitar_baixar() then
    raise exception 'SEM_PERMISSAO: seu usuário não pode alterar honorários.';
  end if;

  select * into v_origem from public.parcelas where id = p_parcela_id;
  if not found then
    raise exception 'PARCELA_NAO_ENCONTRADA';
  end if;

  select * into v_acordo from public.acordos where id = v_origem.acordo_id for update;
  if not found then
    raise exception 'ACORDO_NAO_ENCONTRADO';
  end if;

  if v_acordo.status <> 'ATIVO' then
    raise exception 'ACORDO_NAO_ATIVO: este acordo está % -- honorário só se informa em acordo ativo.', v_acordo.status;
  end if;

  v_valor := round(coalesce(v_origem.honorarios, 0), 2);
  if v_valor <= 0 then
    raise exception 'HONORARIO_ZERADO: informe o honorário desta parcela antes de replicar nas outras.';
  end if;

  for v_p in
    select id, numero, valor
    from public.parcelas
    where acordo_id = v_origem.acordo_id
      and id <> p_parcela_id
      and coalesce(status,'') not in ('PAGO','CANCELADA')
    order by numero
  loop
    -- Honorário maior que a própria parcela é erro; pula e conta, em vez de
    -- derrubar a replicação inteira por causa de uma linha fora do padrão.
    if v_valor > round(coalesce(v_p.valor,0), 2) then
      v_puladas := v_puladas || jsonb_build_object(
        'numero', v_p.numero,
        'motivo', 'honorário maior que a parcela (' || to_char(coalesce(v_p.valor,0),'FM999G999G990D00') || ')'
      );
    else
      update public.parcelas set honorarios = v_valor where id = v_p.id;
      v_alteradas := v_alteradas + 1;
    end if;
  end loop;

  select round(coalesce(sum(honorarios),0),2) into v_soma
  from public.parcelas
  where acordo_id = v_origem.acordo_id and coalesce(status,'') <> 'CANCELADA';

  if v_acordo.aluno_id is not null and v_alteradas > 0 then
    insert into public.aluno_movimentacoes (
      aluno_id, tipo, descricao, registrado_por_email, registrado_em, valor_movimentacao
    ) values (
      v_acordo.aluno_id::text,
      'HONORARIO_INFORMADO',
      concat_ws(' ',
        'Honorário de', to_char(v_valor,'FM999G999G990D00'),
        'replicado da parcela', coalesce(v_origem.numero::text,'?'),
        'para', v_alteradas::text, 'parcela(s) em aberto.',
        case when jsonb_array_length(v_puladas) > 0
             then jsonb_array_length(v_puladas)::text || ' pulada(s).' else '' end,
        'Soma das parcelas agora:', to_char(v_soma,'FM999G999G990D00') || '.',
        nullif(btrim(coalesce(p_motivo,'')),'')
      ),
      v_email, now(), v_valor * v_alteradas
    );
  end if;

  return jsonb_build_object(
    'ok', true,
    'acordo_id', v_origem.acordo_id,
    'honorario', v_valor,
    'parcelas_alteradas', v_alteradas,
    'puladas', v_puladas,
    'soma_das_parcelas', v_soma,
    'honorario_do_acordo', round(coalesce(v_acordo.honorarios_valor,0),2)
  );
end;
$function$;

revoke all on function public.parcela_replicar_honorario(uuid, text) from public;
grant execute on function public.parcela_replicar_honorario(uuid, text) to authenticated;

comment on function public.parcela_replicar_honorario(uuid, text) is
  'Grava o honorario de uma parcela nas demais parcelas EM ABERTO do mesmo acordo -- replica, nao rateia. Nao toca em parcela paga ou cancelada, e pula (sem derrubar a operacao) a parcela onde o honorario nao caberia. Restrito a crm_usuario_pode_quitar_baixar().';
