-- Contadores da aba Conferencia: quanto falta em cada tipo de decisao.
--
-- Quatro listas que respondem a MESMA pergunta -- entrou dinheiro, o que
-- fazemos? -- viraram uma aba so com tipo. Este e o "faltam N" que diz se o dia
-- acabou; sem ele a unificacao seria so cosmetica.
--
-- CUSTO MEDIDO: quitacao_sugerida + possivel_acordo levam ~2,3 s sozinhas -- as
-- duas chamam aluno_saldo_pendente_detalhe por linha. Por isso a TELA nao espera
-- por isto para renderizar: abre no tipo escolhido e preenche os numeros quando
-- chegarem.
--
-- NAO ENTRAM, por decisao da gestao ("tem a parte dos termos e cartoes que nao
-- podemos mexer"): Painel ADM (3 referencias a termo, 24 a cartao/link), Fila de
-- Baixas (5 a link) e Confirmacao de Pagamento (uso diario). Conferencia Prime
-- tambem fica de fora -- e consulta, nao fila.

create or replace function public.conferencia_contadores()
returns jsonb
language plpgsql stable security definer
set search_path to 'public' set statement_timeout to '120s'
as $$
declare r jsonb;
begin
  if not public.usuario_e_gestao() then
    raise exception 'Acesso negado: somente gestao financeira.' using errcode = '42501';
  end if;

  select jsonb_build_object(
    'vincular',  (select count(*) from public.pagamentos_sem_aluno()),
    'quitar',    (select count(*) from public.quitacao_sugerida(30)),
    'acordo',    (select count(*) from public.possivel_acordo()),
    'ajustar',   (select coalesce(max(total_faixa),0)
                    from public.conciliacao_santander(date '2026-07-01', 0, 1))
  ) into r;
  return r;
end;
$$;

revoke all on function public.conferencia_contadores() from public, anon;
grant execute on function public.conferencia_contadores() to authenticated, service_role;
