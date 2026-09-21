-- ROLLBACK de 20260922100000_confirmacao_vinculo_pagamentos.
-- Restaura trg_pagamentos_gerar_confirmacao ao texto de producao (md5(pg_get_functiondef)=9ba8d57594960ff839d22f92f3240066)
-- e remove a tabela de vinculo (os vinculos gravados desde a migration sao descartados; nenhum dado de negocio e tocado).
begin;

CREATE OR REPLACE FUNCTION public.trg_pagamentos_gerar_confirmacao()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  with al as (
    select id, translate(upper(regexp_replace(trim(coalesce(nome,'')),'\s+',' ','g')),'ÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇ','AAAAAEEEEIIIIOOOOOUUUUC') nome_norm
    from public.alunos where coalesce(trim(nome),'')<>''),
  al_uni as (select nome_norm, (max(id::text))::uuid aluno_id from al group by nome_norm having count(*)=1),
  pag as (
    select translate(upper(regexp_replace(trim(coalesce(aluno_nome,'')),'\s+',' ','g')),'ÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇ','AAAAAEEEEIIIIOOOOOUUUUC') nome_norm,
      max(aluno_nome) aluno_nome, round(sum(coalesce(valor_pago,0)),2) valor,
      max(operador_email) op_email, max(operador_nome) op_nome, data_pagamento dt
    from new_rows
    where coalesce(trim(aluno_nome),'')<>'' and data_pagamento is not null
    group by 1, data_pagamento),
  elegivel as (
    select u.aluno_id, p.aluno_nome, p.valor, p.op_email, p.op_nome, p.dt
    from pag p join al_uni u using(nome_norm)
    -- Janela de 90 dias, nao "mes corrente" (Amanda, 02/09). O corte de mes
    -- fazia o arquivo do dia 1o perder tudo que era do mes anterior.
    where p.dt >= current_date - 90
  ),
  -- Reimportação do mesmo dia: atualiza o valor da que já está aguardando,
  -- em vez de criar outra linha para o mesmo pagamento.
  atualizadas as (
    update public.solicitacoes_confirmacao_pagamento s
       set valor_informado = e.valor,
           aluno_nome      = coalesce(s.aluno_nome, e.aluno_nome),
           operador_email  = coalesce(s.operador_email, e.op_email),
           operador_nome   = coalesce(s.operador_nome, e.op_nome),
           atualizado_em   = now()
      from elegivel e
     where s.aluno_id = e.aluno_id::text
       and s.data_pagamento = e.dt
       and s.status = 'AGUARDANDO_CONFIRMACAO'
    returning s.aluno_id, s.data_pagamento
  )
  insert into public.solicitacoes_confirmacao_pagamento
    (aluno_id, aluno_nome, valor_informado, operador_email, operador_nome, data_pagamento, tipo_pagamento, status, motivo)
  select e.aluno_id::text, e.aluno_nome, e.valor, e.op_email, e.op_nome, e.dt, null,
         'AGUARDANDO_CONFIRMACAO', 'Gerado do import de pagamentos Santander'
  from elegivel e
  where not exists (
    select 1 from public.solicitacoes_confirmacao_pagamento s
     where s.aluno_id = e.aluno_id::text
       and s.data_pagamento = e.dt
       and s.status = 'AGUARDANDO_CONFIRMACAO'
  );

  return null;
end;
$function$;

drop table if exists public.solicitacao_confirmacao_pagamentos;

commit;
