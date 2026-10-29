-- O import gera confirmação sempre -- só não repete o que já está na fila.
--
-- Amanda, 26/08/2026: "sim, continua gerando a cada nova importação mas não
-- duplicar o que já está na fila".
--
-- O QUE A TRAVA ANTIGA FAZIA. Ela pulava o aluno que tivesse QUALQUER
-- solicitação em AGUARDANDO_CONFIRMACAO **ou PAGAMENTO_CONFIRMADO**, de
-- qualquer data. Quem apareceu uma vez, mesmo em julho, mesmo já confirmado,
-- nunca mais gerava confirmação.
--
-- Medido: dos 1.228 alunos que pagaram no mês corrente, 1.069 (87%) estavam
-- barrados por isso; só 159 geravam. E a regra de fechamento automático que
-- subiu hoje piorava o efeito -- cada confirmação fechada excluía aquele aluno
-- para sempre.
--
-- A REGRA NOVA: uma solicitação EM ABERTO por aluno e por data de pagamento.
--
--   não existe aguardando para (aluno, data)  -> cria
--   já existe aguardando para (aluno, data)   -> ATUALIZA o valor, não duplica
--
-- O update importa porque a mesma remessa é reimportada várias vezes no mesmo
-- dia conforme o relatório cresce (em 25/08 foram quatro: 44, 54, 66 e 72
-- linhas). Sem ele, ou a fila duplicava, ou o valor ficava congelado no da
-- primeira importação.
--
-- Confirmação já concluída não bloqueia mais nada: pagamento novo em outro dia
-- gera solicitação nova, que é o esperado de quem paga todo mês.
--
-- Segue valendo o recorte de mês corrente.

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

comment on function public.trg_pagamentos_gerar_confirmacao() is
  'Gera confirmacao a cada import: uma solicitacao EM ABERTO por aluno e por data de pagamento. Reimportacao do mesmo dia atualiza o valor em vez de duplicar. Confirmacao ja concluida nao bloqueia mais nada -- antes, quem tivesse qualquer solicitacao (mesmo antiga e ja confirmada) nunca mais gerava, o que barrava 87% dos pagamentos do mes.';
