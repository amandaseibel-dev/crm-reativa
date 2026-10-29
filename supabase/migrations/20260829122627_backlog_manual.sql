-- Quanto trabalho de lancamento ainda esta na mao, ao vivo.
--
-- Amanda, 28/08/2026: "ainda nao vinculamos todas as mensalidades aos acordos e
-- nao baixamos os pagamentos efetivamente pagos, tem muita coisa manual ainda a
-- ser feito, essa visao nao esta correta".
--
-- Ela estava certa, e isso invalida qualquer leitura de "o aluno nao pagou"
-- tirada da ausencia de registro. Medido no dia: 2.886 pagamentos recebidos
-- (R$ 3.480.557,72) que nao fecharam parcela nem titulo, 2.065 acordos ativos
-- sem mensalidade vinculada, 1.719 acordos na fila de confirmacao e 843
-- confirmacoes abertas.
--
-- POR QUE VIROU FUNCAO E NAO TEXTO NA TELA: numero escrito na mao envelhece e
-- volta a enganar justamente quando o backlog diminui -- que e quando as listas
-- passariam a ser confiaveis. As telas AcordosSemPagamento e QuitacoesAConferir
-- leem isto para avisar o leitor do tamanho da fila no momento em que ele olha.

create or replace function public.backlog_manual()
returns jsonb
language plpgsql stable security definer
set search_path to 'public' set statement_timeout to '60s'
as $$
declare r jsonb;
begin
  if not public.usuario_e_gestao() then
    raise exception 'Acesso negado: somente gestao financeira.' using errcode = '42501';
  end if;

  select jsonb_build_object(
    'pagamentos_sem_baixa', (
      select count(*) from public.pagamentos p
       where p.aluno_id is not null
         and not exists (select 1 from public.acordos a join public.parcelas pa on pa.acordo_id=a.id
                          where a.aluno_id=p.aluno_id and pa.status='PAGO')
         and not exists (select 1 from public.acordos_titulos t
                          where t.cpf=p.cpf and t.situacao='PAGO')),
    'pagamentos_sem_baixa_valor', (
      select round(coalesce(sum(p.valor_pago),0),2) from public.pagamentos p
       where p.aluno_id is not null
         and not exists (select 1 from public.acordos a join public.parcelas pa on pa.acordo_id=a.id
                          where a.aluno_id=p.aluno_id and pa.status='PAGO')
         and not exists (select 1 from public.acordos_titulos t
                          where t.cpf=p.cpf and t.situacao='PAGO')),
    'acordos_sem_vinculo', (
      select count(*) from public.acordos a
       where upper(coalesce(a.status,''))='ATIVO'
         and not exists (select 1 from public.acordo_titulo_vinculo v
                          where v.acordo_id=a.id and v.ativo)),
    'confirmacoes_abertas', (
      select count(*) from public.solicitacoes_confirmacao_pagamento
       where status in ('AGUARDANDO_CONFIRMACAO','PAGAMENTO_RECEBIDO_AGUARDANDO_VINCULO')),
    'fila_acordos_pendente', (
      select count(*) from public.fila_acordos_confirmar
       where coalesce(status_confirmacao,'') not in ('CONFIRMADO','REJEITADO')),
    'ultimo_pagamento', (select max(data_pagamento) from public.pagamentos)
  ) into r;
  return r;
end;
$$;

revoke all on function public.backlog_manual() from public, anon;
grant execute on function public.backlog_manual() to authenticated, service_role;
