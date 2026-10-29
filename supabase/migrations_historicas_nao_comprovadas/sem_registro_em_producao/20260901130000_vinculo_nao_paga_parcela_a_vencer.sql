-- O VINCULO AUTOMATICO PARA DE PAGAR PARCELA QUE AINDA NAO VENCEU.
--
-- Amanda, 01/09/2026: "baixou parcela a vencer errada... considerou a segunda
-- parcela pq nao tem a entrada e a premissa era bater o titulo".
--
-- O DEFEITO: `conferencia_vincular_pagamento` percorre as parcelas do acordo do
-- vencimento mais antigo para o mais novo e marca PAGO enquanto o dinheiro
-- cobrir a parcela inteira -- sem nunca perguntar se a parcela ja venceu.
--
-- Por que isso estoura justamente aqui: a ENTRADA do acordo NAO e importada,
-- entao ela nao existe como parcela. O dinheiro da entrada entra pelo extrato,
-- nao acha a divida que pagou, e a funcao gasta ele na parcela 1, na 2, na 3 --
-- chegou ate a parcela 9. O aluno fica com meio acordo "pago" sem ter pago.
--
-- MEDIDO EM PROD, baixas da Conferencia de 31/08 e 01/09/2026:
--   parcelas ja vencidas marcadas    151   R$ 130.682,81   133 alunos
--   parcelas A VENCER marcadas       214   R$ 182.896,48    86 alunos
--
-- A REGRA QUE ENTRA: dinheiro paga o que JA VENCEU. Parcela futura nunca e
-- quitada por sobra -- o excedente fica como sobra e a pessoa decide.
--
-- NAO E A CORRECAO FINAL. A premissa da Amanda -- "a premissa era bater o
-- titulo" -- pede casar o dinheiro com o titulo/entrada, nao consumir parcela em
-- ordem. Isto aqui fecha a torneira; o casamento por titulo e conversa separada.
--
-- DESFAZER: supabase/rollbacks/20260901130000_vinculo_nao_paga_parcela_a_vencer.rollback.sql
-- REPARAR O QUE JA PASSOU: supabase/recovery/20260901_devolver_parcelas_a_vencer_da_conferencia.sql

create or replace function public.conferencia_vincular_pagamento(
  p_aluno_id uuid, p_valor numeric, p_data date, p_baixa_id uuid default null
) returns jsonb
language plpgsql security definer
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

    -- do vencimento mais antigo para o mais novo, enquanto o dinheiro cobrir,
    -- e SO no que ja venceu. Parcela futura nao e quitada por sobra: a entrada
    -- nao e importada, entao a sobra quase sempre e dinheiro dela -- e era isso
    -- que estava sendo gasto na parcela 2, 3, 4 de quem nao pagou nada delas.
    for r in
      select p.id, p.valor
        from public.parcelas p
       where p.acordo_id = v_acordo
         and upper(coalesce(p.status,'')) not in ('PAGO','CANCELADA','CANCELADO','ESTORNADA','ESTORNADO')
         and p.vencimento <= current_date
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

    -- O RECALCULO E A ULTIMA COISA. A baixa dispara recalculo na hora em que e
    -- inserida -- ou seja, ANTES deste abatimento. Sem recalcular aqui, o saldo
    -- fica com o estado velho e o aluno aparece quitado devendo.
    begin perform public.recalcular_situacao_aluno(p_aluno_id, 'baixa_extrato'); exception when others then null; end;
    return jsonb_build_object('ligou', v_pagas > 0, 'acordo_id', v_acordo,
                              'parcelas_pagas', v_pagas, 'sobrou', v_restante);
  end if;

  -- sem acordo ativo: o dinheiro quita mensalidade, da mais antiga para a mais
  -- nova, e tambem so o que ja venceu.
  for r in
    select t.id, coalesce(t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0) valor
      from public.acordos_titulos t
     where t.aluno_id = p_aluno_id
       and upper(coalesce(t.situacao,'')) = 'ABERTO'
       and coalesce(t.saldo_corrigido, t.valor_em_aberto, t.valor_original, 0) > 0
       and t.vencimento <= current_date
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
