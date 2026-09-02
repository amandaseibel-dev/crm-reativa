-- O relatorio de pagamento parava de gerar confirmacao na virada do mes.
--
-- Amanda, 02/09: "pq todos os casos do relatorio de pagamento nao estao indo
-- para a confirmacao de pagamento?".
--
-- O DEFEITO. `trg_pagamentos_gerar_confirmacao` so cria a solicitacao quando
-- `data_pagamento >= date_trunc('month', current_date)` -- o pagamento tem de
-- ser do MES CORRENTE. Todo dia 1o, o arquivo que ainda traz os pagamentos do
-- fim do mes passado entra no sistema e nao gera confirmacao nenhuma. Em
-- silencio: a linha nao vai para a fila, nao vai para /pagamentos-sem-aluno,
-- nao vai para lugar nenhum.
--
-- MEDIDO EM PROD (02/09/2026):
--   ontem, 01/09      33 linhas   R$  66.947,13   pagamentos de agosto descartados
--   ultimos 30 dias   92 linhas   R$ 154.162,34
--
-- A REGRA QUE ENTRA: janela de 90 dias a contar da importacao, decidida pela
-- Amanda. Cobre a virada do mes e o pagamento que chega atrasado no arquivo,
-- sem abrir o historico -- se alguem reimportar um arquivo antigo, a fila nao
-- e inundada de casos de anos anteriores.
--
-- O QUE ESTA MIGRATION NAO RESOLVE: a segunda causa, o nome que casa com
-- ZERO ou DOIS+ alunos (homonimo ou nao cadastrado). Sem saber de quem e o
-- dinheiro nao da para abrir confirmacao para ninguem. Sao 62 linhas /
-- R$ 176.617,90 em 30 dias, e elas ja tem casa: aparecem em
-- /pagamentos-sem-aluno para vinculo manual. Exemplo de hoje: Leandro Silva da
-- Silva, R$ 346,59 -- tres cadastros com o mesmo nome.
--
-- REPROCESSAMENTO -- TODOS OS DIAS, com o corte que a Amanda pediu em 02/09:
-- "eu nao quero ter que voltar aos casos que ja foram feitos", "so se tiver
-- nova entrada de pagamento", "os outros dias tambem devem entrar nessa
-- contagem".
--
-- Entao: sem limite de data de importacao, e SEM recriar confirmacao de caso ja
-- resolvido. Varrendo a base inteira, sao 68 grupos (aluno + data de pagamento)
-- que a regra do mes descartou desde sempre -- R$ 185.907,97:
--
--   ja tem confirmacao para a mesma data          5                  nao entra
--   caso ja resolvido (encerrado ou saldo zero)  32   R$ 83.453,20   NAO entra
--   dinheiro entrou e ninguem conferiu           31   R$ 58.348,50   ENTRA
--
-- Os 32 sao justamente os casos que ela nao quer rever: o dinheiro ja foi
-- tratado por outro caminho. Os 31 tem divida aberta -- ali o pagamento
-- realmente nunca foi conferido por ninguem. Sao pagamentos de 02/07 a 31/08:
-- a base inteira cabe nessa janela, nao ha nada mais antigo sendo cortado.
--
-- DESFAZER: supabase/rollbacks/20260902150000_confirmacao_do_relatorio_nao_para_na_virada_do_mes.rollback.sql

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

-- --------------------------------------------------------------------------
-- Reprocessamento: o que a regra do mes descartou nos ultimos 30 dias
-- --------------------------------------------------------------------------
create table if not exists public._backup_confirmacao_reprocessada_20260902 (
  aluno_id text, data_pagamento date, criado_em timestamptz default now()
);
alter table public._backup_confirmacao_reprocessada_20260902 enable row level security;

with al as (
  select id, translate(upper(regexp_replace(trim(coalesce(nome,'')),'\s+',' ','g')),'ÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇ','AAAAAEEEEIIIIOOOOOUUUUC') nome_norm
  from public.alunos where coalesce(trim(nome),'')<>''),
al_uni as (select nome_norm, (max(id::text))::uuid aluno_id from al group by nome_norm having count(*)=1),
pag as (
  select translate(upper(regexp_replace(trim(coalesce(aluno_nome,'')),'\s+',' ','g')),'ÁÀÂÃÄÉÈÊËÍÌÎÏÓÒÔÕÖÚÙÛÜÇ','AAAAAEEEEIIIIOOOOOUUUUC') nome_norm,
    max(aluno_nome) aluno_nome, round(sum(coalesce(valor_pago,0)),2) valor,
    max(operador_email) op_email, max(operador_nome) op_nome, data_pagamento dt
  from public.pagamentos
  where data_pagamento is not null and coalesce(trim(aluno_nome),'')<>''
    -- exatamente o que o corte de mes jogou fora na hora da importacao,
    -- em TODOS os dias de importacao (sem janela): a base inteira sao 68 grupos
  and data_pagamento < date_trunc('month', created_at::date)::date
  group by 1, data_pagamento),
novas as (
  insert into public.solicitacoes_confirmacao_pagamento
    (aluno_id, aluno_nome, valor_informado, operador_email, operador_nome, data_pagamento, tipo_pagamento, status, motivo)
  select u.aluno_id::text, p.aluno_nome, p.valor, p.op_email, p.op_nome, p.dt, null,
         'AGUARDANDO_CONFIRMACAO',
         'Gerado do import de pagamentos Santander (reprocessado em 02/09: pulado pelo corte de mes)'
    from pag p
    join al_uni u using(nome_norm)
    join public.alunos al2 on al2.id = u.aluno_id
    left join public.casos c on c.aluno_id = u.aluno_id
   where not exists (
     select 1 from public.solicitacoes_confirmacao_pagamento s
      where s.aluno_id = u.aluno_id::text and s.data_pagamento = p.dt)
     -- caso ja resolvido nao volta: so entra quem ainda tem divida aberta
     and not coalesce(c.encerrado_operacional, false)
     and coalesce(al2.saldo_total, 0) > 0.005
  returning aluno_id, data_pagamento
)
insert into public._backup_confirmacao_reprocessada_20260902 (aluno_id, data_pagamento)
select aluno_id, data_pagamento from novas;
