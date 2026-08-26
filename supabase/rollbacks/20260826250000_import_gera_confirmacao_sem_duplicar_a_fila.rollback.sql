-- Rollback: volta a trava larga.
--
-- ATENÇÃO: com a versão antiga, quem já teve QUALQUER solicitação (mesmo
-- antiga e já confirmada) nunca mais gera confirmação nova. Isso barrava 87%
-- dos pagamentos do mês -- 1.069 de 1.228 alunos.
create or replace function public.trg_pagamentos_gerar_confirmacao()
returns trigger language plpgsql security definer set search_path to 'public'
as $function$
begin
  with al as (
    select id, translate(upper(regexp_replace(trim(coalesce(nome,'')),'\s+',' ','g')),'ÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇ','AAAAAEEEEIIIIOOOOOUUUUC') nome_norm
    from public.alunos where coalesce(trim(nome),'')<>''),
  al_uni as (select nome_norm, (max(id::text))::uuid aluno_id from al group by nome_norm having count(*)=1),
  pag as (
    select translate(upper(regexp_replace(trim(coalesce(aluno_nome,'')),'\s+',' ','g')),'ÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇ','AAAAAEEEEIIIIOOOOOUUUUC') nome_norm,
      max(aluno_nome) aluno_nome, round(sum(coalesce(valor_pago,0)),2) valor,
      max(operador_email) op_email, max(operador_nome) op_nome, max(data_pagamento) dt
    from new_rows where coalesce(trim(aluno_nome),'')<>'' group by 1),
  jatem as (select distinct aluno_id from public.solicitacoes_confirmacao_pagamento
            where status in ('AGUARDANDO_CONFIRMACAO','PAGAMENTO_CONFIRMADO') and aluno_id is not null)
  insert into public.solicitacoes_confirmacao_pagamento
    (aluno_id, aluno_nome, valor_informado, operador_email, operador_nome, data_pagamento, tipo_pagamento, status, motivo)
  select u.aluno_id::text, p.aluno_nome, p.valor, p.op_email, p.op_nome, p.dt, null,
         'AGUARDANDO_CONFIRMACAO', 'Gerado do import de pagamentos Santander'
  from pag p join al_uni u using(nome_norm)
  where u.aluno_id::text not in (select aluno_id from jatem)
    and p.dt is not null and p.dt >= date_trunc('month', current_date)::date;
  return null;
end $function$;
