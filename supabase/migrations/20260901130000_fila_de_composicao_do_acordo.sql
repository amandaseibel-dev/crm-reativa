-- Lista de conferencia: acordo ATIVO no CRM com mensalidade do aluno ainda
-- ABERTA e solta. Nesse estado a mesma divida pode contar duas vezes -- pela
-- parcela do acordo e pela mensalidade.
--
-- ESTA FUNCAO NAO DECIDE NADA e nao escreve nada. Ela acha os casos e junta a
-- evidencia; quem decide quais mensalidades entram e a pessoa. A composicao nao
-- existe em fonte nenhuma -- nem no Prime (`agreements` vazio; os boletos de
-- acordo nao aparecem no extrato: zero de 8.938), nem no relatorio da Ulbra
-- (`No Importacao` vazio nas 9.466 linhas), nem no arquivo de pagamento
-- (`parcela_original` preenchido em 1 de 8.465 linhas).
-- Ver [[importacao-de-acordo-nao-vincula-mensalidade]].
--
-- A evidencia que vai junto, e o que cada peca vale:
--   * `no_166` -- o aluno esta no portador Santander ReATIVA. Marca de que
--     negociou: 2.814 de 2.820 nos casos de composicao conhecida.
--   * `datas_liquidacao` -- quantas datas distintas o Prime mostra. Uma so
--     reforca; varias nao derrubam (o Ananias tem quatro e mesmo assim negociou).
--   * `qtd_acordos_ativos` -- se for mais de um, a pessoa PRECISA escolher a
--     qual acordo cada mensalidade pertence.
--
-- ATENCAO ao julgar: mensalidade solta que esta no portador 195 (ReATIVA
-- Recuperacao de Credito) e divida DEVIDA -- regra da Amanda, 01/09. Foi o caso
-- da Manuela Agliardi Camargo, cujo acordo era de set a dez/2025 enquanto as
-- mensalidades abertas eram de marco a junho/2026: divida nova, nao composicao.

create or replace function public.composicao_acordo_pendentes(p_limite int default 300)
returns table (
  aluno_id uuid, nome text, cpf text,
  saldo numeric, qtd_acordos_ativos int, valor_acordos numeric,
  qtd_mensalidades int, valor_mensalidades numeric,
  no_166 boolean, datas_liquidacao int, liquidadas_antes_do_venc int
)
language sql security definer set search_path to 'public' set statement_timeout to '120s'
as $$
  with permitido as (select public.usuario_e_gestao() ok)
  select al.id, al.nome, al.cpf,
         round(coalesce(al.saldo_total,0),2),
         (select count(*)::int from public.acordos a
           where a.aluno_id = al.id and upper(coalesce(a.status,''))='ATIVO'),
         (select round(coalesce(sum(a.valor_total),0),2) from public.acordos a
           where a.aluno_id = al.id and upper(coalesce(a.status,''))='ATIVO'),
         count(*)::int,
         round(sum(coalesce(t.valor_em_aberto, t.saldo_corrigido, t.valor_original, 0)),2),
         exists (select 1 from public.prime_portador_membro m
                  where m.cpf = regexp_replace(coalesce(al.cpf,''),'\D','','g')
                    and m.portador = 166),
         count(distinct pe.liquidado_em)::int,
         count(*) filter (where pe.liquidado_em < t.vencimento)::int
    from permitido, public.alunos al
    join public.acordos_titulos t on t.aluno_id = al.id
    left join public.prime_extrato pe on pe.boleto = t.documento
   where permitido.ok
     and upper(coalesce(t.situacao,'')) = 'ABERTO'
     and t.acordo_id is null
     and coalesce(t.tipo_boleto,'') <> 'Acordo'
     and exists (select 1 from public.acordos a
                  where a.aluno_id = al.id and upper(coalesce(a.status,''))='ATIVO')
   group by al.id, al.nome, al.cpf, al.saldo_total
   order by sum(coalesce(t.valor_em_aberto, t.saldo_corrigido, t.valor_original, 0)) desc
   limit greatest(coalesce(p_limite, 300), 1);
$$;

revoke all on function public.composicao_acordo_pendentes(int) from public, anon;
grant execute on function public.composicao_acordo_pendentes(int) to authenticated, service_role;
