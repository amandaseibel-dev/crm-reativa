-- Desfaz 20260902150000_confirmacao_do_relatorio_nao_para_na_virada_do_mes.sql
--
-- Volta o gatilho ao corte de mes corrente (pagamento de mes anterior deixa de
-- gerar confirmacao) e encerra as confirmacoes criadas pelo reprocessamento.

create or replace function public.trg_pagamentos_gerar_confirmacao()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
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
    where p.dt >= date_trunc('month', current_date)::date
  ),
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

-- tira da fila o que o reprocessamento criou (nao apaga: encerra com motivo)
update public.solicitacoes_confirmacao_pagamento s
   set status = 'ENCERRADO_SEM_VALOR',
       motivo = coalesce(s.motivo,'') || ' | desfeito pelo rollback de 20260902150000',
       atualizado_em = now()
  from public._backup_confirmacao_reprocessada_20260902 b
 where s.aluno_id = b.aluno_id and s.data_pagamento = b.data_pagamento
   and s.status = 'AGUARDANDO_CONFIRMACAO';

drop table if exists public._backup_confirmacao_reprocessada_20260902;
