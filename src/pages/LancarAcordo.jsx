import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "../services/supabase";
import { podeGerirFinanceiro } from "../utils/operadores";
import { S } from "../ui/estilosFila";
import {
  lancarAcordo, gerarParcelas, paraNumero, paraDataBR, hojeISO, somarMeses,
} from "../utils/lancarAcordo";

// Lançar acordo -- a bancada de lançamento, com o relatório do Santander do lado.
//
// O PROBLEMA QUE ESTA TELA RESOLVE. O acordo sempre existe de verdade lá fora;
// o que falta é ele estar no sistema (Amanda, 26/08/2026: "o acordo sempre
// existe de verdade, só preciso lançar no sistema"). Até aqui o único caminho
// era: buscar o aluno, abrir a ficha, rolar até o Financeiro, abrir "Montar
// novo acordo", preencher, salvar, voltar, buscar o próximo. Com centenas de
// linhas de relatório para lançar na mão, o caminho ERA o gargalo.
//
// Aqui o ritmo é outro: cola o CPF, Enter, preenche, lança, e o cursor volta
// sozinho para o CPF, pronto para o próximo. Sem sair da tela.
//
// O QUE ELA MOSTRA ANTES DE DEIXAR LANÇAR: os acordos que o aluno JÁ tem.
// A trava de duplicado no banco recusa o clone, mas ver antes é melhor do que
// tomar erro depois -- e mostra na hora se o caso é "já está lançado" ou
// "é outro acordo mesmo".
//
// QUEM PODE. Amanda, Fernanda e Amanda ADM (Amanda, 26/08/2026: "só eu e a
// fernanda e amanda podemos lançar esses acordos"). A tela esconde; o RLS de
// acordos_insert recusa de verdade. As duas coisas, porque tela sozinha é
// combinado, não trava.

function moeda(n) {
  return (Number(n) || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function formatCpf(v) {
  const d = String(v || "").replace(/\D/g, "").padStart(11, "0").slice(-11);
  return `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`;
}

function soDigitos(v) {
  return String(v || "").replace(/\D/g, "");
}

function formInicial() {
  return {
    valorTotal: "",
    qtdParcelas: "1",
    temEntrada: false,
    entradaRs: "",
    entradaPct: "",
    entradaPaga: true,
    dataEntrada: paraDataBR(hojeISO()),
    honorariosEntrada: "0",
    honorarios: "",
    primeiroVenc: paraDataBR(somarMeses(hojeISO(), 1)),
    parcelas: [],
  };
}

const E = {
  bloco: { background: "#fff", border: "1px solid #e6eaf0", borderRadius: 12, padding: "16px 18px", marginBottom: 14, boxShadow: "0 1px 2px rgba(15,23,42,0.04)" },
  blocoTitulo: { fontFamily: "'Sora', Inter, sans-serif", fontSize: 14, fontWeight: 800, color: "#0d1321", marginBottom: 12 },
  linha: { display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end" },
  campo: { display: "flex", flexDirection: "column", gap: 5 },
  rotulo: { fontSize: 11.5, fontWeight: 700, color: "#64748b", textTransform: "uppercase", letterSpacing: "0.03em" },
  input: { border: "1px solid #cbd5e1", borderRadius: 10, padding: "9px 12px", fontSize: 14, background: "#fff", color: "#0f172a", outline: "none", width: 150 },
  inputCpf: { border: "1px solid #cbd5e1", borderRadius: 10, padding: "10px 14px", fontSize: 16, background: "#fff", color: "#0f172a", outline: "none", width: 260, fontVariantNumeric: "tabular-nums" },
  botao: { background: "#1e40af", color: "#fff", border: "none", borderRadius: 10, padding: "10px 20px", fontWeight: 700, fontSize: 13.5, cursor: "pointer" },
  botaoSec: { background: "#fff", color: "#1e40af", border: "1px solid #c7d2fe", borderRadius: 10, padding: "10px 18px", fontWeight: 700, fontSize: 13.5, cursor: "pointer" },
  botaoLancar: { background: "#166534", color: "#fff", border: "none", borderRadius: 10, padding: "12px 26px", fontWeight: 800, fontSize: 14.5, cursor: "pointer" },
  desabilitado: { opacity: 0.5, cursor: "not-allowed" },
  tabela: { width: "100%", borderCollapse: "collapse", fontSize: 13 },
  th: { textAlign: "left", padding: "8px 10px", color: "#64748b", fontSize: 11.5, fontWeight: 700, textTransform: "uppercase", borderBottom: "1px solid #eef1f6" },
  td: { padding: "6px 10px", borderBottom: "1px solid #f4f6fa", color: "#0f172a" },
  tdTotal: { padding: "9px 10px", fontWeight: 800, color: "#0d1321", borderTop: "2px solid #e2e8f0" },
  inputTab: { border: "1px solid #e2e8f0", borderRadius: 8, padding: "5px 8px", fontSize: 13, width: 110, color: "#0f172a", background: "#fff" },
  ok: { background: "#f0fdf4", border: "1px solid #bbf7d0", color: "#166534", borderRadius: 10, padding: "12px 16px", fontSize: 13.5, fontWeight: 700, marginBottom: 14 },
  alerta: { background: "#fffbeb", border: "1px solid #fde68a", color: "#92400e", borderRadius: 10, padding: "10px 14px", fontSize: 13, fontWeight: 600, marginTop: 10 },
  chip: { fontSize: 12, fontWeight: 800, borderRadius: 999, padding: "3px 11px", background: "#f1f5f9", color: "#334155", border: "1px solid #e2e8f0" },
};

export default function LancarAcordo() {
  const [usuario, setUsuario] = useState(null);
  const [busca, setBusca] = useState("");
  const [buscando, setBuscando] = useState(false);
  const [aluno, setAluno] = useState(null);
  const [acordosDoAluno, setAcordosDoAluno] = useState([]);
  const [erro, setErro] = useState("");
  const [form, setForm] = useState(formInicial());
  const [salvando, setSalvando] = useState(false);
  const [ultimo, setUltimo] = useState(null);
  const [lancadosAgora, setLancadosAgora] = useState([]);
  const campoBusca = useRef(null);
  // Trava de duplo-clique: o disabled cobre o caso normal, o ref cobre a
  // corrida antes do setState propagar. Aqui isso vale dobrado -- dois cliques
  // rápidos são exatamente como nasce um acordo duplicado.
  const salvandoRef = useRef(false);

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => setUsuario(data?.user || null));
  }, []);

  const email = usuario?.email || "";
  const podeLancar = podeGerirFinanceiro(email);

  useEffect(() => {
    campoBusca.current?.focus();
  }, []);

  async function buscar() {
    const termo = String(busca || "").trim();
    if (!termo) return;
    setBuscando(true);
    setErro("");
    setAluno(null);
    setAcordosDoAluno([]);
    setUltimo(null);

    const digitos = soDigitos(termo);
    let q = supabase
      .from("alunos")
      .select("id, nome, cpf, responsavel_atual_email, situacao")
      .limit(20);

    // CPF completo é a busca do dia a dia (colado do relatório). Nome é o
    // socorro para quando o relatório vem sem CPF utilizável.
    q = digitos.length >= 11 ? q.ilike("cpf", `%${digitos.slice(-11)}%`) : q.ilike("nome", `%${termo}%`);

    const { data, error } = await q;
    setBuscando(false);

    if (error) { setErro("Erro na busca: " + error.message); return; }
    if (!data?.length) { setErro("Nenhum aluno encontrado para “" + termo + "”."); return; }
    if (data.length > 1) {
      setAcordosDoAluno([]);
      setAluno({ varios: data });
      return;
    }
    await selecionar(data[0]);
  }

  async function selecionar(a) {
    setAluno(a);
    setErro("");
    setForm(formInicial());
    // Os acordos que o aluno já tem -- ver antes é melhor do que tomar o erro
    // da trava de duplicado depois de preencher a tela inteira.
    const { data } = await supabase
      .from("acordos")
      .select("id, numero_acordo, valor_total, qtd_parcelas, status, honorarios_valor, saldo, criado_em")
      .eq("aluno_id", String(a.id))
      .order("criado_em", { ascending: false });
    setAcordosDoAluno(data || []);
  }

  function atualizar(campo, valor) {
    setForm((atual) => ({ ...atual, [campo]: valor }));
  }

  function atualizarValorTotal(valor) {
    setForm((atual) => {
      // A % da entrada fica fixa e o R$ acompanha o total -- senão a entrada
      // trava no valor antigo e o parcelado sai errado.
      if (!atual.temEntrada || !atual.entradaPct) return { ...atual, valorTotal: valor };
      const total = paraNumero(valor);
      const pct = Number(String(atual.entradaPct).replace(",", ".")) || 0;
      const rs = total > 0 ? ((total * pct) / 100).toFixed(2) : atual.entradaRs;
      return { ...atual, valorTotal: valor, entradaRs: rs };
    });
  }

  function atualizarEntradaRs(valor) {
    setForm((atual) => {
      const total = paraNumero(atual.valorTotal);
      const rs = paraNumero(valor);
      return { ...atual, entradaRs: valor, entradaPct: total > 0 ? ((rs / total) * 100).toFixed(1) : "" };
    });
  }

  function atualizarEntradaPct(valor) {
    setForm((atual) => {
      const total = paraNumero(atual.valorTotal);
      const pct = Number(String(valor).replace(",", ".")) || 0;
      return { ...atual, entradaPct: valor, entradaRs: total > 0 ? ((total * pct) / 100).toFixed(2) : "" };
    });
  }

  function gerar() {
    const r = gerarParcelas(form);
    if (r.erro) { setErro(r.erro); return; }
    setErro("");
    setForm((atual) => ({ ...atual, parcelas: r.parcelas, honorariosEntrada: r.honorariosEntrada }));
  }

  function atualizarParcela(i, campo, valor) {
    setForm((atual) => ({
      ...atual,
      parcelas: atual.parcelas.map((p, ix) => (ix === i ? { ...p, [campo]: valor } : p)),
    }));
  }

  async function lancar() {
    if (salvandoRef.current) return;
    if (!aluno?.id) { setErro("Busque o aluno primeiro."); return; }
    if (!form.parcelas.length) { setErro('Clique em "Gerar parcelas" antes de lançar.'); return; }

    salvandoRef.current = true;
    setSalvando(true);
    setErro("");

    const r = await lancarAcordo({ aluno, dados: form, usuarioEmail: email });

    salvandoRef.current = false;
    setSalvando(false);

    if (!r.ok) { setErro(r.erro); return; }

    const resumo = {
      numero: r.acordo?.numero_acordo || r.acordo?.id?.slice(0, 8),
      nome: aluno.nome,
      cpf: aluno.cpf,
      total: paraNumero(form.valorTotal),
      honorarios: paraNumero(form.honorarios),
      parcelas: form.parcelas.length,
      avisos: r.avisos || [],
    };
    setUltimo(resumo);
    setLancadosAgora((atual) => [resumo, ...atual]);

    // Pronto para o próximo: limpa tudo e devolve o cursor ao CPF. Esse é o
    // ritmo da tela -- lançar em série, sem tirar a mão do teclado.
    setAluno(null);
    setAcordosDoAluno([]);
    setForm(formInicial());
    setBusca("");
    campoBusca.current?.focus();
  }

  const somaParcelas = useMemo(
    () => form.parcelas.reduce((s, p) => s + paraNumero(p.valor), 0),
    [form.parcelas],
  );
  const somaHonorarios = useMemo(
    () => form.parcelas.reduce((s, p) => s + paraNumero(p.honorarios), 0) + paraNumero(form.honorariosEntrada),
    [form.parcelas, form.honorariosEntrada],
  );
  const entradaRs = form.temEntrada ? Math.min(paraNumero(form.entradaRs), paraNumero(form.valorTotal)) : 0;
  const totalConferido = somaParcelas + entradaRs;
  const totalInformado = paraNumero(form.valorTotal);
  const honorariosInformado = paraNumero(form.honorarios);
  // Diferença de centavo é arredondamento do rateio e não é problema; acima
  // disso alguém editou uma parcela na mão e o acordo não fecha.
  const difValor = Math.abs(totalConferido - totalInformado);
  const difHonorarios = Math.abs(somaHonorarios - honorariosInformado);

  const totalLancado = lancadosAgora.reduce((s, l) => s + l.total, 0);
  const totalHonLancado = lancadosAgora.reduce((s, l) => s + l.honorarios, 0);

  if (usuario && !podeLancar) {
    return (
      <div style={S.wrap}>
        <h1 style={S.titulo}>Lançar acordo</h1>
        <p style={S.sub}>
          Lançamento de acordo é da gestão financeira (Amanda, Fernanda e Amanda ADM).
        </p>
      </div>
    );
  }

  const ativosIguais = acordosDoAluno.filter((a) => a.status === "ATIVO");

  return (
    <div style={S.wrap}>
      <div style={S.topo}>
        <div>
          <h1 style={S.titulo}>Lançar acordo</h1>
          <p style={S.sub}>
            Cola o CPF, Enter, preenche e lança. O cursor volta sozinho para o próximo.
          </p>
        </div>
        {lancadosAgora.length > 0 && (
          <div style={S.contadores}>
            <span style={S.contadorAlunos}>{lancadosAgora.length} lançado(s) agora</span>
            <span style={S.contadorValor}>{moeda(totalLancado)}</span>
            <span style={S.contadorAcordos}>{moeda(totalHonLancado)} em honorários</span>
          </div>
        )}
      </div>

      {ultimo && (
        <div style={E.ok}>
          ✅ Acordo nº {ultimo.numero} lançado para {ultimo.nome} — {moeda(ultimo.total)} em{" "}
          {ultimo.parcelas}x, {moeda(ultimo.honorarios)} de honorários.
          {ultimo.avisos.length > 0 && (
            <div style={E.alerta}>{ultimo.avisos.join(" ")}</div>
          )}
        </div>
      )}

      {erro && <div style={S.erroBox}>{erro}</div>}

      <div style={E.bloco}>
        <div style={E.blocoTitulo}>1. Aluno</div>
        <div style={E.linha}>
          <div style={E.campo}>
            <span style={E.rotulo}>CPF ou nome</span>
            <input
              ref={campoBusca}
              style={E.inputCpf}
              value={busca}
              placeholder="Cole o CPF e tecle Enter"
              onChange={(e) => setBusca(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") buscar(); }}
            />
          </div>
          <button style={E.botao} onClick={buscar} disabled={buscando}>
            {buscando ? "Buscando..." : "Buscar"}
          </button>
        </div>

        {aluno?.varios && (
          <div style={{ marginTop: 12 }}>
            <div style={{ ...E.rotulo, marginBottom: 6 }}>
              {aluno.varios.length} alunos encontrados — escolha:
            </div>
            {aluno.varios.map((a) => (
              <button
                key={a.id}
                style={{ ...E.botaoSec, display: "block", width: "100%", textAlign: "left", marginBottom: 6 }}
                onClick={() => selecionar(a)}
              >
                {a.nome} — {formatCpf(a.cpf)}
              </button>
            ))}
          </div>
        )}

        {aluno?.id && (
          <div style={{ marginTop: 12 }}>
            <div style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
              <span style={S.cardNome}>{aluno.nome}</span>
              <span style={S.cardCpf}>{formatCpf(aluno.cpf)}</span>
              <span style={E.chip}>
                {aluno.responsavel_atual_email ? "Operador: " + aluno.responsavel_atual_email : "sem operador"}
              </span>
            </div>

            {acordosDoAluno.length > 0 && (
              <div style={{ marginTop: 12 }}>
                <div style={{ ...E.rotulo, marginBottom: 6 }}>
                  Este aluno já tem {acordosDoAluno.length} acordo(s)
                  {ativosIguais.length > 0 ? ` — ${ativosIguais.length} ativo(s)` : ""}
                </div>
                <table style={E.tabela}>
                  <thead>
                    <tr>
                      <th style={E.th}>Nº</th>
                      <th style={E.th}>Valor</th>
                      <th style={E.th}>Parcelas</th>
                      <th style={E.th}>Honorários</th>
                      <th style={E.th}>Saldo</th>
                      <th style={E.th}>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {acordosDoAluno.map((a) => (
                      <tr key={a.id}>
                        <td style={E.td}>{a.numero_acordo || "—"}</td>
                        <td style={E.td}>{moeda(a.valor_total)}</td>
                        <td style={E.td}>{a.qtd_parcelas}x</td>
                        <td style={E.td}>
                          {Number(a.honorarios_valor || 0) > 0 ? moeda(a.honorarios_valor) : "não informado"}
                        </td>
                        <td style={E.td}>{moeda(a.saldo)}</td>
                        <td style={E.td}>{a.status}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {ativosIguais.length > 0 && (
                  <div style={E.alerta}>
                    Confira se o acordo do relatório não é um desses. Acordo ATIVO igual (mesmo
                    valor e mesmas parcelas) é recusado pelo sistema.
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {aluno?.id && (
        <>
          <div style={E.bloco}>
            <div style={E.blocoTitulo}>2. O acordo</div>
            <div style={E.linha}>
              <div style={E.campo}>
                <span style={E.rotulo}>Valor total</span>
                <input style={E.input} value={form.valorTotal} placeholder="Ex: 3.200,00"
                  onChange={(e) => atualizarValorTotal(e.target.value)} />
              </div>
              <div style={E.campo}>
                <span style={E.rotulo}>Honorários do acordo</span>
                <input style={E.input} value={form.honorarios} placeholder="Ex: 320,00"
                  onChange={(e) => atualizar("honorarios", e.target.value)} />
              </div>
              <div style={E.campo}>
                <span style={E.rotulo}>Qtd. parcelas</span>
                <input style={{ ...E.input, width: 90 }} value={form.qtdParcelas}
                  onChange={(e) => atualizar("qtdParcelas", e.target.value)} />
              </div>
              <div style={E.campo}>
                <span style={E.rotulo}>1º vencimento</span>
                <input style={E.input} value={form.primeiroVenc} placeholder="dd/mm/aaaa"
                  onChange={(e) => atualizar("primeiroVenc", e.target.value)} />
              </div>
            </div>

            <div style={{ ...E.linha, marginTop: 14 }}>
              <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13.5, fontWeight: 700, color: "#334155" }}>
                <input type="checkbox" checked={form.temEntrada}
                  onChange={(e) => atualizar("temEntrada", e.target.checked)} />
                Tem entrada
              </label>
              {form.temEntrada && (
                <>
                  <div style={E.campo}>
                    <span style={E.rotulo}>Entrada R$</span>
                    <input style={E.input} value={form.entradaRs}
                      onChange={(e) => atualizarEntradaRs(e.target.value)} />
                  </div>
                  <div style={E.campo}>
                    <span style={E.rotulo}>Entrada %</span>
                    <input style={{ ...E.input, width: 90 }} value={form.entradaPct}
                      onChange={(e) => atualizarEntradaPct(e.target.value)} />
                  </div>
                  <div style={E.campo}>
                    <span style={E.rotulo}>Data da entrada</span>
                    <input style={E.input} value={form.dataEntrada} placeholder="dd/mm/aaaa"
                      onChange={(e) => atualizar("dataEntrada", e.target.value)} />
                  </div>
                  <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13.5, fontWeight: 700, color: "#334155" }}>
                    <input type="checkbox" checked={form.entradaPaga}
                      onChange={(e) => atualizar("entradaPaga", e.target.checked)} />
                    Entrada já paga
                  </label>
                </>
              )}
              <button style={E.botaoSec} onClick={gerar}>Gerar parcelas</button>
            </div>

            {form.temEntrada && !form.entradaPaga && (
              <div style={E.alerta}>
                Entrada ainda não paga entra como parcela nº 0 a vencer — assim ela continua
                sendo cobrada em vez de sumir do saldo.
              </div>
            )}
          </div>

          {form.parcelas.length > 0 && (
            <div style={E.bloco}>
              <div style={E.blocoTitulo}>3. Parcelas</div>
              <table style={E.tabela}>
                <thead>
                  <tr>
                    <th style={E.th}>Parcela</th>
                    <th style={E.th}>Vencimento</th>
                    <th style={E.th}>Valor</th>
                    <th style={E.th}>Honorários</th>
                  </tr>
                </thead>
                <tbody>
                  {form.temEntrada && entradaRs > 0 && (
                    <tr>
                      <td style={E.td}><strong>Entrada</strong></td>
                      <td style={E.td}>{form.dataEntrada}</td>
                      <td style={E.td}>{moeda(entradaRs)}</td>
                      <td style={E.td}>
                        <input style={E.inputTab} value={form.honorariosEntrada}
                          onChange={(e) => atualizar("honorariosEntrada", e.target.value)} />
                      </td>
                    </tr>
                  )}
                  {form.parcelas.map((p, i) => (
                    <tr key={p.numero}>
                      <td style={E.td}>{p.numero}</td>
                      <td style={E.td}>
                        <input style={E.inputTab} value={p.vencimento}
                          onChange={(e) => atualizarParcela(i, "vencimento", e.target.value)} />
                      </td>
                      <td style={E.td}>
                        <input style={E.inputTab} value={p.valor}
                          onChange={(e) => atualizarParcela(i, "valor", e.target.value)} />
                      </td>
                      <td style={E.td}>
                        <input style={E.inputTab} value={p.honorarios}
                          onChange={(e) => atualizarParcela(i, "honorarios", e.target.value)} />
                      </td>
                    </tr>
                  ))}
                  <tr>
                    <td style={E.tdTotal} colSpan={2}>Soma</td>
                    <td style={E.tdTotal}>{moeda(totalConferido)}</td>
                    <td style={E.tdTotal}>{moeda(somaHonorarios)}</td>
                  </tr>
                </tbody>
              </table>

              {difValor > 0.05 && (
                <div style={E.alerta}>
                  A soma das parcelas ({moeda(totalConferido)}) não bate com o valor total
                  informado ({moeda(totalInformado)}). Confira antes de lançar.
                </div>
              )}
              {honorariosInformado > 0 && difHonorarios > 0.05 && (
                <div style={E.alerta}>
                  A soma dos honorários das parcelas ({moeda(somaHonorarios)}) não bate com o
                  honorário do acordo ({moeda(honorariosInformado)}).
                </div>
              )}

              <div style={{ marginTop: 16 }}>
                <button
                  style={{ ...E.botaoLancar, ...(salvando ? E.desabilitado : {}) }}
                  onClick={lancar}
                  disabled={salvando}
                >
                  {salvando ? "Lançando..." : "Lançar acordo"}
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {lancadosAgora.length > 0 && (
        <div style={E.bloco}>
          <div style={E.blocoTitulo}>Lançados nesta sessão</div>
          <table style={E.tabela}>
            <thead>
              <tr>
                <th style={E.th}>Nº</th>
                <th style={E.th}>Aluno</th>
                <th style={E.th}>Valor</th>
                <th style={E.th}>Parcelas</th>
                <th style={E.th}>Honorários</th>
              </tr>
            </thead>
            <tbody>
              {lancadosAgora.map((l, i) => (
                <tr key={`${l.numero}-${i}`}>
                  <td style={E.td}>{l.numero}</td>
                  <td style={E.td}>{l.nome}</td>
                  <td style={E.td}>{moeda(l.total)}</td>
                  <td style={E.td}>{l.parcelas}x</td>
                  <td style={E.td}>{moeda(l.honorarios)}</td>
                </tr>
              ))}
              <tr>
                <td style={E.tdTotal} colSpan={2}>Total</td>
                <td style={E.tdTotal}>{moeda(totalLancado)}</td>
                <td style={E.tdTotal}></td>
                <td style={E.tdTotal}>{moeda(totalHonLancado)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
