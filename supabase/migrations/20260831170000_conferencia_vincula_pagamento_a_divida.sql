-- A baixa passa a LIGAR o dinheiro a divida que ele pagou.
--
-- Amanda, 31/08: "quando entra no Santander precisa ir para essa fila de baixa
-- para vincularmos o acordo a mensalidade paga, simples apenas isso". E sobre o
-- valor: "nao precisa bater, pq ja falamos tem juros e multas e honorarios".
--
-- O QUE ESTAVA ERRADO. `conferencia_baixar_do_extrato` registrava a baixa sem
-- `parcela_id` nem `acordo_id` e sem tocar em titulo nenhum. O dinheiro entrava
-- como "recebido" e a divida ficava de pe. Como `confirmar_baixa_caso` so quita
-- quando o saldo zera, ele nunca quitava -- e a unica saida virava o botao
-- "Quitar", que zerava tudo as cegas. Medido no John Willian: baixa de
-- R$ 34.289,40 e os quatro titulos dele intocados desde 04/07.
--
-- A REGRA: do vencimento mais ANTIGO para o mais novo, enquanto o dinheiro
-- cobrir a parcela inteira. O que sobrar e juros, multa e honorario -- nao vira
-- credito nem sai procurando outra divida.
--
-- ONDE ATUA. So quando o destino e UNICO, para nunca adivinhar:
--   * exatamente um acordo ATIVO com parcela em aberto  -> paga as parcelas
--   * nenhum acordo ATIVO, so mensalidade em aberto     -> quita os titulos
-- Quem tem mais de um acordo ativo fica de fora e segue na fila para escolha
-- manual. Medido em 31/08: 1.231 de 1.330 pessoas tem destino unico (92,6%);
-- 96 sao ambiguas.
--
-- NAO ZERA NADA ALEM DO QUE O DINHEIRO COBRE. Se o pagamento nao alcanca a
-- proxima parcela, para ali e o resto continua devido -- o oposto do que o
-- "Quitar" fazia.
--
-- Testado em prod com rollback, na Sarah Oleszko Lemes: 4 parcelas pagas,
-- sobrou R$ 0,00, saldo caiu exatamente os R$ 7.605,58 que entraram.
--
-- DESFAZER: supabase/rollbacks/20260831170000_conferencia_vincula_pagamento_a_divida.rollback.sql

create or replace function public.conferencia_vincular_pagamento(
  p_aluno_id uuid,
  p_valor    numeric,
  p_data     date,
  p_baixa_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_acordo uuid;
  v_qtd_acordos int;
  v_restante numeric := round(coalesce(p_valor,0), 2);
  v_pagas int := 0;
  v_titulos int := 0;
  v_primeira uuid;
  r record;
begin
  if p_aluno_id is null or v_restante <= 0 then
    return jsonb_build_object('ligou', false, 'motivo', 'SEM_VALOR');
  end if;

  select count(*) into v_qtd_acordos
    from public.acordos a
   where a.aluno_id = p_aluno_id and upper(coalesce(a.status,'')) = 'ATIVO';

  -- mais de um acordo ativo: nao da para saber qual foi pago
  if v_qtd_acordos > 1 then
    return jsonb_build_object('ligou', false, 'motivo', 'MAIS_DE_UM_ACORDO_ATIVO');
  end if;

  if v_qtd_acordos = 1 then
    select a.id into v_acordo
      from public.acordos a
     where a.aluno_id = p_aluno_id and upper(coalesce(a.status,'')) = 'ATIVO'
     limit 1;

    for r in
      select p.id, p.valor
        from public.parcelas p
       where p.acordo_id = v_acordo
         and upper(coalesce(p.status,'')) not in ('PAGO','CANCELADA','CANCELADO','ESTORNADA','ESTORNADO')
       order by p.vencimento asc, p.numero asc
    loop
      exit when v_restante < round(coalesce(r.valor,0), 2);
      update public.parcelas
         set status = 'PAGO', atualizado_em = now()
       where id = r.id;
      v_restante := round(v_restante - round(coalesce(r.valor,0), 2), 2);
      v_pagas := v_pagas + 1;
      if v_primeira is null then v_primeira := r.id; end if;
    end loop;

    -- deixa registrado na baixa A QUE divida o dinheiro se refere
    if p_baixa_id is not null then
      update public.baixas_pagamento
         set acordo_id = v_acordo,
             parcela_id = coalesce(parcela_id, v_primeira),
             atualizado_em = now()
       where id = p_baixa_id;
    end if;

    -- O RECALCULO E A ULTIMA COISA, e isto nao e detalhe.
    --
    -- A baixa dispara recalculo no momento em que e INSERIDA -- ou seja, ANTES
    -- deste abatimento acontecer. Sem recalcular aqui, o saldo fica congelado no
    -- estado anterior e o aluno aparece quitado devendo.
    --
    -- Foi o que aconteceu com o Eduardo Oliveira do Nascimento em 31/08: acordo
    -- QUITADO, parcela PAGO, dois titulos quitados as 13:17:52 -- e R$ 5.867,58
    -- ainda constando em aberto.
    begin perform public.recalcular_situacao_aluno(p_aluno_id, 'baixa_extrato'); exception when others then null; end;
    return jsonb_build_object('ligou', v_pagas > 0, 'acordo_id', v_acordo,
                              'parcelas_pagas', v_pagas, 'sobrou', v_restante);
  end if;

  -- sem acordo ativo: o dinheiro quita mensalidade, da mais antiga para a mais nova
  for r in
    select t.id, coalesce(t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0) valor
      from public.acordos_titulos t
     where t.aluno_id = p_aluno_id
       and upper(coalesce(t.situacao,'')) = 'ABERTO'
       and coalesce(t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0) > 0
     order by t.vencimento asc, t.id asc
  loop
    exit when v_restante < round(r.valor, 2);
    update public.acordos_titulos
       set situacao = 'PAGO', status = 'quitada',
           saldo_corrigido = 0, valor_em_aberto = 0,
           motivo_ajuste = coalesce(motivo_ajuste,'')
                           || case when coalesce(motivo_ajuste,'') = '' then '' else ' | ' end
                           || 'quitada pela baixa do extrato em ' || to_char(coalesce(p_data, current_date),'DD/MM/YYYY'),
           atualizado_em = now()
     where id = r.id;
    v_restante := round(v_restante - round(r.valor, 2), 2);
    v_titulos := v_titulos + 1;
  end loop;

  begin perform public.recalcular_situacao_aluno(p_aluno_id, 'baixa_extrato'); exception when others then null; end;
  return jsonb_build_object('ligou', v_titulos > 0, 'acordo_id', null,
                            'titulos_quitados', v_titulos, 'sobrou', v_restante);
end;
$function$;

revoke all on function public.conferencia_vincular_pagamento(uuid, numeric, date, uuid) from public, anon;
grant execute on function public.conferencia_vincular_pagamento(uuid, numeric, date, uuid) to authenticated, service_role;

-- E a baixa passa a chamar o vinculo. Aplicado em prod por substituicao de
-- trecho, preservando o corpo de `conferencia_baixar_do_extrato`.
do $do$
declare v_def text; v_novo text;
begin
  select pg_get_functiondef(p.oid) into v_def
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname='public' and p.proname='conferencia_baixar_do_extrato';

  if v_def is null then
    raise exception 'conferencia_baixar_do_extrato nao existe -- migration fora de ordem';
  end if;
  if v_def like '%conferencia_vincular_pagamento%' then return; end if;

  v_novo := replace(v_def,
'       v_email, v_email, now(), v_id, round(p_valor,2));
  end if;',
'       v_email, v_email, now(), v_id, round(p_valor,2));
  end if;

  -- LIGA O DINHEIRO A DIVIDA QUE ELE PAGOU.
  v_vinculo := public.conferencia_vincular_pagamento(p_aluno_id, p_valor, p_data, coalesce(v_id, v_ja));');

  v_novo := replace(v_novo,
    'v_nome text; v_cpf text; v_id uuid; v_ja uuid; v_confs int := 0;',
    'v_nome text; v_cpf text; v_id uuid; v_ja uuid; v_confs int := 0; v_vinculo jsonb;');

  v_novo := replace(v_novo,
    '''confirmacoes_fechadas'', v_confs);',
    '''confirmacoes_fechadas'', v_confs, ''vinculo'', v_vinculo);');

  if v_novo = v_def then raise exception 'nao casou -- nada alterado'; end if;
  execute v_novo;
end $do$;
