-- "Quantos CPFs eu tenho de mensalidade e quantos de acordo?"
--
-- Pedido da gestao em 10/09/2026, para a operacao enxergar a propria carteira
-- dividida do jeito que ela realmente e: divida a cobrar de um lado, acordo a
-- acompanhar do outro. Sao trabalhos diferentes e ate hoje apareciam somados
-- num unico "casos ativos".
--
-- Conta por CPF, nao por ficha: aluno com ficha duplicada e uma pessoa so. Sem
-- CPF, cai no id do caso para nao sumir da conta.
--
-- Cada operador so enxerga a propria carteira: o parametro e ignorado para quem
-- nao e gestao. Nao e informacao secreta, mas carteira alheia no painel de
-- alguem so gera comparacao improdutiva -- e a gestao tem a Calibragem.
create or replace function public.minha_carteira_resumo(p_operador_email text default null)
returns table (
  operador_email text, operador_nome text,
  cpfs_so_mensalidade int, cpfs_com_acordo int,
  cpfs_acordo_e_mensalidade int, cpfs_total int,
  valor_mensalidade numeric, valor_acordo numeric
)
language sql stable security definer set search_path = public
as $$
  with alvo as (
    select case when (public.usuario_e_gestao() or auth.jwt() is null)
                 and coalesce(p_operador_email,'') <> ''
                then lower(p_operador_email)
                else lower(coalesce(auth.jwt()->>'email','')) end e
  ),
  b as (
    select c.operador_email, c.operador_nome,
           coalesce(nullif(lpad(regexp_replace(coalesce(c.cpf_limpo, c.cpf, ''), '\D','','g'), 11, '0'), '00000000000'),
                    c.id::text) chave,
           coalesce(s.saldo_mensalidade,0) mens,
           coalesce(s.saldo_acordo,0) acor
      from public.casos c
      join public.calibragem_saldo_aluno s on s.aluno_id = c.aluno_id, alvo
     where lower(c.operador_email) = alvo.e
       and coalesce(s.saldo_total,0) > 0
       and not public.caso_encerrado_operacional(c.cpf_limpo, c.status_atual,
             c.status_acionamento, c.status_financeiro, c.status_jornada)
  )
  select max(operador_email), max(operador_nome),
         count(distinct chave) filter (where mens > 0 and acor = 0)::int,
         count(distinct chave) filter (where acor > 0)::int,
         count(distinct chave) filter (where acor > 0 and mens > 0)::int,
         count(distinct chave)::int,
         round(coalesce(sum(mens) filter (where acor = 0), 0), 2),
         round(coalesce(sum(acor), 0), 2)
    from b
   having count(*) > 0;
$$;

revoke all on function public.minha_carteira_resumo(text) from public, anon;
grant execute on function public.minha_carteira_resumo(text) to authenticated;

comment on function public.minha_carteira_resumo(text) is
  'Resumo da propria carteira: CPFs so com mensalidade, CPFs com acordo e os valores. Operador ve so o seu; gestao pode passar o e-mail de outro.';
