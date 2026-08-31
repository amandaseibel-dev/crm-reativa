// Confirmação de Pagamento: UMA lista, uma linha por pessoa.
//
// Mora no lugar da antiga Confirmacao de Pagamento, por decisao da gestao --
// "se esta redundante, utilize ela como referencia para criar a nova dentro
// dela". Mesma aba, mesmo lugar no menu; o conteudo e que mudou.
//
// Amanda: "organize a fila e todos os pagamentos que entraram por aluno, sem se
// repetir os alunos, deixe uma aba para conferencia de pagamentos, nao precisamos
// de diversas, vamos centralizar em lugar so".
//
// A DESCOBERTA QUE SIMPLIFICOU TUDO: as quatro filas anteriores eram FATIAS DA
// MESMA POPULACAO -- aluno com pagamento nao conferido. "Quitacao sugerida",
// "Possivel acordo" e "Conciliacao" olhavam o mesmo conjunto por angulos
// diferentes. A diferenca entre elas e atributo da LINHA, nao fila separada.
//
// Por isso a linha traz os FATOS -- quanto entrou, quanto ainda deve (partido em
// acordo e mensalidade), se tem acordo ativo -- e quem decide e a pessoa. Nada de
// situacao derivada de comparar pago com saldo: pagamento a vista vem maior que o
// principal e isso nao e sinal de nada (premissa 17).
//
// A FILA NASCE DO EXTRATO. O ponto de partida e o pagamento que entrou no
// Santander e ninguem conferiu -- nao o saldo. Cada decisao carimba os pagamentos
// daquela pessoa, entao a lista zera quando o extrato acabar. Era o vinculo que
// nao existia: `pagamento_id` estava nulo nas 8.209 solicitacoes.
//
// Estado ao ligar: 2.679 linhas (1.365 com aluno + 1.314 so com nome),
// 5.572 pagamentos, R$ 9.026.477,20 que entraram, R$ 6.323.939,30 em aberto.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "../services/supabase";
import { S } from "../ui/estilosFila";
import Aluno from "./Aluno";

const moeda = (v) => Number(v || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const curta = (d) => (d ? String(d).slice(0, 10).split("-").reverse().join("/") : "-");

// Faixa sobre o VALOR PAGO -- decisao da gestao: "sempre o valor pago". A fila
// e do dinheiro que entrou, entao "acima de quanto?" e sobre o pagamento, nao
// sobre a divida. Efeito bom: as linhas sem vinculo deixam de sumir com faixa,
// porque elas tem valor pago (so nao tem saldo).
// O QUE A FILA MOSTRA POR PADRAO.
//
// Amanda, 31/08: "se nao tem mensalidade, parcelas estao em dia e tem operador
// responsavel, o que faz na fila?". Sem nada a vincular, nada vencido e com dono
// definido, nao ha decisao humana a tomar -- eram 256 pessoas e R$ 837.862,30 so
// fazendo volume. O padrao passa a esconder esses; "Tudo" traz de volta.
const TIPOS = [
  { chave: null,          rotulo: "A fazer",        dica: "Esconde quem nao tem mensalidade, esta com as parcelas em dia e ja tem operador — nao ha o que decidir." },
  { chave: "MENSALIDADE", rotulo: "Com mensalidade", dica: "So quem tem mensalidade em aberto: e onde o vinculo mensalidade x acordo precisa ser feito." },
  { chave: "ACORDO",      rotulo: "Só acordo",       dica: "So quem nao tem mensalidade em aberto — o dinheiro so precisa ser registrado." },
  { chave: "TUDO",        rotulo: "Tudo",            dica: "Inclui tambem quem ja esta resolvido, para conferir o conjunto." },
];

const FAIXAS = [
  { min: 0, rotulo: "Qualquer valor" },
  { min: 1000, rotulo: "R$ 1 mil +" },
  { min: 5000, rotulo: "R$ 5 mil +" },
  { min: 10000, rotulo: "R$ 10 mil +" },
  { min: 20000, rotulo: "R$ 20 mil +" },
  { min: 50000, rotulo: "R$ 50 mil +" },
];

// Periodo. Abre em JULHO E AGOSTO por decisao da gestao -- "quero julho e
// agosto, depois voltamos em junho". Junho fica a um clique: quando o arquivo
// dele for importado, entra sem inundar a fila antes da hora.
const MESES = [
  { chave: "JUL_AGO", rotulo: "Julho e agosto", de: "2026-07-01", ate: "2026-09-01" },
  { chave: "2026-07", rotulo: "Só julho", de: "2026-07-01", ate: "2026-08-01" },
  { chave: "2026-08", rotulo: "Só agosto", de: "2026-08-01", ate: "2026-09-01" },
  { chave: "2026-06", rotulo: "Junho", de: "2026-06-01", ate: "2026-07-01" },
  { chave: "TUDO", rotulo: "Tudo", de: null, ate: null },
];

const SEGUNDOS_DESFAZER = 12;

export default function ConferenciaPagamentos() {
  const [linhas, setLinhas] = useState([]);
  const [totais, setTotais] = useState({ linhas: 0, pagamentos: 0, entrou: 0, baixado: 0, saldo: 0 });
  const [carregando, setCarregando] = useState(false);
  const [erro, setErro] = useState("");
  const [faixa, setFaixa] = useState(0);
  const [tipoDivida, setTipoDivida] = useState(null);
  const [mes, setMes] = useState("JUL_AGO");
  const [de, setDe] = useState("");
  const [ate, setAte] = useState("");
  const [busca, setBusca] = useState("");
  const [buscaAtiva, setBuscaAtiva] = useState("");
  const [cursor, setCursor] = useState(0);
  const [confirmando, setConfirmando] = useState(null);
  const [vinculando, setVinculando] = useState(null); // {chave, termo, achados}
  const [ocupado, setOcupado] = useState(null);
  const [desfazer, setDesfazer] = useState(null);
  const [placar, setPlacar] = useState({ n: 0, valor: 0 });
  const [fichaId, setFichaId] = useState(null);
  const buscaRef = useRef(null);

  const carregar = useCallback(async () => {
    setCarregando(true); setErro("");
    // Data livre ganha do seletor de mes; sem nenhum dos dois, usa o padrao da
    // funcao (01/06) -- junho ainda nao tem dado, mas quando entrar ja cobre.
    const m = MESES.find((x) => x.chave === mes);
    const desde = de || m?.de || undefined;
    const limite = ate || m?.ate || undefined;
    const { data, error } = await supabase.rpc("conferencia_pagamentos", {
      ...(desde ? { p_desde: desde } : {}),
      ...(limite ? { p_ate: limite } : {}),
      p_valor_min: faixa, p_limite: 300,
      ...(tipoDivida ? { p_tipo_divida: tipoDivida } : {}),
    });
    if (error) setErro(error.message);
    const d = data || [];
    setLinhas(d);
    setTotais({
      linhas: d[0]?.total_linhas ?? d.length,
      pagamentos: d[0]?.total_pagamentos ?? 0,
      entrou: d[0]?.total_entrou ?? 0,
      baixado: d[0]?.total_baixado ?? 0,
      saldo: d[0]?.total_saldo ?? 0,
    });
    setCursor(0);
    setCarregando(false);
  }, [faixa, mes, de, ate, tipoDivida]);

  useEffect(() => { carregar(); }, [carregar]);

  useEffect(() => {
    const t = setTimeout(() => setBuscaAtiva(busca), 180);
    return () => clearTimeout(t);
  }, [busca]);

  const visiveis = useMemo(() => {
    const t = buscaAtiva.trim().toLowerCase();
    if (!t) return linhas;
    const dig = t.replace(/\D/g, "");
    return linhas.filter((x) =>
      String(x.nome || "").toLowerCase().includes(t) ||
      (dig && String(x.cpf || "").replace(/\D/g, "").includes(dig)));
  }, [linhas, buscaAtiva]);

  const alvo = visiveis.length === 0 ? -1 : Math.min(cursor, visiveis.length - 1);
  const chaveDe = (l) => (l.aluno_id || `nome:${l.nome}`);

  useEffect(() => {
    if (!desfazer) return undefined;
    const t = setTimeout(() => setDesfazer(null), SEGUNDOS_DESFAZER * 1000);
    return () => clearTimeout(t);
  }, [desfazer]);

  function tirarDaTela(l) {
    setLinhas((ls) => ls.filter((x) => chaveDe(x) !== chaveDe(l)));
    setTotais((t) => ({
      ...t,
      linhas: Math.max(0, t.linhas - 1),
      pagamentos: Math.max(0, t.pagamentos - Number(l.qtd_pagamentos || 0)),
    }));
    setPlacar((p) => ({ n: p.n + 1, valor: p.valor + Number(l.saldo_aberto || 0) }));
  }

  // UM BOTAO SO: "Feito".
  //
  // Eram tres -- Baixar, Ja baixado e Quitar -- e a Amanda pediu um so depois de
  // descobrirmos, em 31/08, que dois deles nao faziam o que prometiam:
  //
  //  * "Baixar" registrava o dinheiro mas NAO abatia a divida. A baixa entrava
  //    sem parcela e sem acordo ligados, os titulos ficavam intocados, o saldo
  //    nao caia -- e por isso `confirmar_baixa_caso`, que so quita se o saldo
  //    zerar, nunca quitava. Medido no John Willian: baixa de R$ 34.289,40 e os
  //    quatro titulos dele intocados desde 04/07;
  //
  //  * "Quitar" chamava `quitar_e_encerrar_caso`, que zera TUDO -- saldo,
  //    parcelas e titulos -- sem comparar com o valor pago, e a tela ainda
  //    passava `p_confirmar_acordo_em_dia: true`, desligando a unica protecao
  //    que existia. Como o saldo nunca caia pelo "Baixar", a tela empurrava
  //    justamente para o botao perigoso.
  //
  // Agora ha um caminho so, e ele NUNCA ZERA NADA: registra a baixa do extrato
  // e marca a pessoa como conferida. `conferencia_baixar_do_extrato` ja ignora
  // baixa repetida (mesmo aluno, mesma data, mesmo valor), entao clicar em quem
  // ja foi baixado por outro fluxo apenas marca como conferido.
  //
  // A quitacao volta a ser consequencia: quando a divida realmente zerar, o
  // caso quita sozinho. Enquanto o abatimento nao existir, ninguem zera por
  // engano a partir daqui.
  async function aplicar(l, observacao) {
    setOcupado(chaveDe(l)); setConfirmando(null);
    try {
      const { error: eb } = await supabase.rpc("conferencia_baixar_do_extrato", {
        p_aluno_id: l.aluno_id, p_valor: Number(l.entrou),
        p_data: l.ultimo_pagamento, p_observacao: observacao || null,
      });
      if (eb) throw eb;

      // Quita SOMENTE se o saldo ja estiver zerado. Quem ainda deve segue na
      // cobranca -- e o que impede a tela de apagar divida.
      const { error } = await supabase.rpc("confirmar_baixa_caso", {
        p_aluno_id: l.aluno_id, p_valor_pago: Number(l.entrou),
        p_data_pagamento: l.ultimo_pagamento, p_confirmacao_id: null,
      });
      if (error) throw error;

      const { error: e2 } = await supabase.rpc("conciliacao_santander_decidir", {
        p_aluno_id: l.aluno_id, p_decisao: "CONFIRMADO",
        p_motivo: observacao || null, p_valor: Number(l.entrou),
      });
      if (e2) throw e2;
      tirarDaTela(l);
      setDesfazer({ linha: l, acao: "CONFIRMADO" });
    } catch (e) {
      alert("Não foi possível concluir: " + (e?.message || String(e)));
    } finally { setOcupado(null); }
  }

  const desfazerAgora = useCallback(async () => {
    if (!desfazer) return;
    const { linha, acao } = desfazer;
    setDesfazer(null);
    const { error } = await supabase.rpc("conciliacao_santander_desfazer", { p_aluno_id: linha.aluno_id });
    if (error) { alert("Não foi possível desfazer: " + error.message); return; }
    setLinhas((ls) => [linha, ...ls].sort((a, b) => Number(b.saldo_aberto) - Number(a.saldo_aberto)));
    setTotais((t) => ({ ...t, linhas: t.linhas + 1, pagamentos: t.pagamentos + Number(linha.qtd_pagamentos || 0) }));
    setPlacar((p) => ({ n: Math.max(0, p.n - 1), valor: Math.max(0, p.valor - Number(linha.saldo_aberto || 0)) }));
    if (acao !== "REJEITADO") {
      alert("Voltou para a fila. A baixa em si NÃO foi estornada — se for o caso, desfaça pelo fluxo do Financeiro.");
    }
  }, [desfazer]);

  // ---- vincular: dinheiro que não achou dono ----
  async function procurarAluno(l, termo) {
    setVinculando((v) => ({ ...v, termo, achados: null, buscando: true }));
    const { data } = await supabase.rpc("buscar_aluno", { p_termo: termo });
    setVinculando((v) => (v ? { ...v, achados: (data || []).slice(0, 8), buscando: false } : v));
  }

  // CADASTRAR QUEM NAO ESTA NA BASE.
  //
  // Amanda, 31/08: "tem casos a vincular que nao tem cadastro e tem acordo para
  // acompanhamento". Ate agora o sistema inteiro tinha UM unico caminho que cria
  // aluno -- `importar_acordos`. Nenhuma tela inseria aluno. Entao, quando
  // entrava dinheiro de alguem fora da base, a fila mostrava "sem vinculo" e a
  // saida era montar uma planilha de uma linha so para importar.
  //
  // A RPC nao cria acordo nem caso e nao mexe em dinheiro: so abre a ficha, para
  // o pagamento ter em quem ser ligado. Se o CPF ja existir, ela devolve o aluno
  // existente em vez de criar outro -- cadastro repetido nesta base ja custou
  // uma migration inteira de fusao.
  async function cadastrarEVincular(l) {
    const cpf = String(vinculando?.cpfNovo || "").replace(/\D/g, "");
    const nome = String(vinculando?.nomeNovo || "").trim();
    if (cpf.length !== 11) { alert("Informe os 11 dígitos do CPF."); return; }
    if (nome.length < 3) { alert("Informe o nome do aluno."); return; }
    setOcupado(chaveDe(l));
    try {
      const { data, error } = await supabase.rpc("criar_aluno_para_vinculo", {
        p_nome: nome, p_cpf: cpf, p_unidade: null,
      });
      if (error) throw error;
      const id = data?.aluno_id;
      if (!id) throw new Error("cadastro não retornou o aluno");
      if (data?.criado === false) {
        alert("Esse CPF já estava cadastrado. Vinculando ao cadastro existente.");
      }
      await vincularEm(l, id);
    } catch (e) {
      alert("Não foi possível cadastrar: " + (e?.message || String(e)));
      setOcupado(null);
    }
  }

  async function vincularEm(l, alunoId) {
    setOcupado(chaveDe(l)); setVinculando(null);
    try {
      for (const pid of l.pagamento_ids || []) {
        const { error } = await supabase.rpc("pagamento_vincular_aluno", {
          p_pagamento_id: pid, p_aluno_id: alunoId,
          p_observacao: "Vinculado pela Conferência de Pagamentos",
        });
        if (error) throw error;
      }
      tirarDaTela(l);
    } catch (e) {
      alert("Não foi possível vincular: " + (e?.message || String(e)));
    } finally { setOcupado(null); }
  }

  useEffect(() => {
    function onKey(e) {
      if (fichaId) return;
      const emCampo = ["INPUT", "TEXTAREA"].includes(e.target?.tagName);
      if (e.key === "/" && !emCampo) { e.preventDefault(); buscaRef.current?.focus(); return; }
      if (e.key === "Escape") { setConfirmando(null); setVinculando(null); e.target?.blur?.(); return; }
      if (emCampo) return;
      const l = visiveis[alvo];
      if (e.key === "j" || e.key === "ArrowDown") { e.preventDefault(); setCursor(Math.min(alvo + 1, visiveis.length - 1)); }
      else if (e.key === "k" || e.key === "ArrowUp") { e.preventDefault(); setCursor(Math.max(alvo - 1, 0)); }
      else if (e.key === "u" && desfazer) { e.preventDefault(); desfazerAgora(); }
      else if (!l) return;
      else if (l.tipo === "SEM_VINCULO") {
        if (e.key === "v") { e.preventDefault(); setVinculando({ chave: chaveDe(l), termo: l.nome, achados: null }); procurarAluno(l, l.nome); }
      }
      // F de Feito. C segue valendo por costume de quem ja usava a tela.
      else if (e.key === "f" || e.key === "c") { e.preventDefault(); setConfirmando({ chave: chaveDe(l), acao: "FEITO" }); }
      else if (e.key === "Enter" && l.aluno_id) { e.preventDefault(); setFichaId(l.aluno_id); }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [visiveis, alvo, fichaId, desfazer, desfazerAgora]);

  const rotuloFaixa = FAIXAS.find((f) => f.min === faixa)?.rotulo || "Tudo";

  return (
    <div style={S.wrap}>
      <div style={S.topo}>
        <div>
          <h1 style={S.titulo}>Confirmação de Pagamento</h1>
          <p style={S.sub}>
            Pagamento que <b>ainda não foi conferido</b>, e as baixas do período,
            uma linha por pessoa. Entrou, baixado e saldo lado a lado.
            O extrato do Santander define quem pagou. Quem já está zerado sai da lista — já foi conferido.
            Decidir aqui carimba os pagamentos daquela pessoa, e a fila diminui. Quem pagou
            <b> depois de ter sido quitado</b> vem primeiro — dinheiro novo depois de uma quitação
            total pede um olhar.
          </p>
        </div>
        <button type="button" onClick={carregar} style={S.btnGhost} disabled={carregando}>
          {carregando ? "Carregando…" : "Atualizar"}
        </button>
      </div>

      <div style={faixas}>
        <span style={rotuloGrupo}>Período</span>
        {MESES.map((m) => (
          <button
            key={m.chave} type="button"
            onClick={() => { setMes(m.chave); setDe(""); setAte(""); }}
            style={{ ...chipFaixa, ...(m.chave === mes && !de && !ate ? chipFaixaOn : null) }}
            aria-pressed={m.chave === mes && !de && !ate}
          >
            {m.rotulo}
          </button>
        ))}
        <input type="date" value={de} onChange={(e) => setDe(e.target.value)}
               style={inputData} title="Pagamentos a partir desta data" />
        <span style={{ fontSize: 12, color: "#94a3b8" }}>até</span>
        <input type="date" value={ate} onChange={(e) => setAte(e.target.value)}
               style={inputData} title="Pagamentos antes desta data" />
        {(de || ate) ? (
          <button type="button" style={chipFaixa} onClick={() => { setDe(""); setAte(""); }}>limpar datas</button>
        ) : null}
      </div>

      <div style={faixas}>
        <span style={rotuloGrupo}>Dívida</span>
        {TIPOS.map((t) => (
          <button
            key={t.rotulo} type="button" onClick={() => setTipoDivida(t.chave)}
            style={{ ...chipFaixa, ...(t.chave === tipoDivida ? chipFaixaOn : null) }}
            aria-pressed={t.chave === tipoDivida}
            title={t.dica}
          >
            {t.rotulo}
          </button>
        ))}
        <span style={rotuloGrupo}>Valor pago</span>
        {FAIXAS.map((f) => (
          <button
            key={f.min} type="button" onClick={() => setFaixa(f.min)}
            style={{ ...chipFaixa, ...(f.min === faixa ? chipFaixaOn : null) }}
            aria-pressed={f.min === faixa}
            title="Filtra pelo valor que entrou no extrato, não pelo saldo."
          >
            {f.rotulo}
          </button>
        ))}
        <span style={dicaTeclado}>
          <b>J/K</b> anda · <b>F</b> feito · <b>V</b> vincula · <b>Enter</b> ficha · <b>/</b> busca
        </span>
      </div>

      <div style={S.barra}>
        <input
          ref={buscaRef} style={S.input}
          placeholder="Buscar por nome ou CPF…   (tecle /)"
          value={busca} onChange={(e) => setBusca(e.target.value)}
        />
        <div style={S.contadores}>
          <span style={S.contadorAlunos}>
            {visiveis.length < totais.linhas ? `${visiveis.length} de ${totais.linhas}` : `${totais.linhas}`} pessoas
          </span>
          <span style={S.contadorAlunos}>{totais.pagamentos} pagamentos</span>
          <span style={S.contadorAcordos}>{moeda(totais.entrou)} entrou</span>
          <span style={S.contadorAcordos}>{moeda(totais.baixado)} baixado</span>
          <span style={S.contadorValor}>{moeda(totais.saldo)} em aberto</span>
          {placar.n > 0 ? <span style={S.contadorAcordos}>✓ {placar.n} resolvidos</span> : null}
        </div>
      </div>

      {linhas.length < totais.linhas ? (
        <p style={avisoCorte}>
          Mostrando as <b>{linhas.length}</b> maiores de <b>{totais.linhas}</b> pessoas
          ({totais.pagamentos} pagamentos) na faixa {rotuloFaixa}. Resolva estas e clique em Atualizar,
          ou estreite a faixa.
        </p>
      ) : null}

      {erro ? <div style={S.erroBox}>{erro}</div> : null}
      {!carregando && visiveis.length === 0 ? <p style={S.muted}>Nada pendente de conferência.</p> : null}

      <div style={{ overflowX: "auto" }}>
        <table style={S.tabela}>
          <thead>
            <tr>
              <th style={S.th}>Pessoa</th>
              <th style={S.thNum}>Entrou</th>
              <th style={S.thNum}>Baixado</th>
              <th style={S.thNum}>Saldo</th>
              <th style={S.thNum}>Em acordo</th>
              <th style={S.thNum}>Mensalidade</th>
              <th style={S.thNum}>Vencido</th>
              <th style={S.th}>Ações</th>
            </tr>
          </thead>
          <tbody>
            {visiveis.map((l, i) => {
              const chave = chaveDe(l);
              const destacada = i === alvo;
              const conf = confirmando?.chave === chave ? confirmando.acao : null;
              const vinc = vinculando?.chave === chave ? vinculando : null;
              const semDono = l.tipo === "SEM_VINCULO";
              return (
                <tr key={chave} onMouseEnter={() => setCursor(i)}
                    style={destacada ? { background: "#eff6ff", outline: "2px solid #bfdbfe" } : undefined}>
                  <td style={S.td}>
                    {semDono ? (
                      <span style={{ ...linkNome, textDecoration: "none", cursor: "default" }}>{l.nome}</span>
                    ) : (
                      <button type="button" onClick={() => setFichaId(l.aluno_id)} style={linkNome}>{l.nome}</button>
                    )}
                    <div style={sub}>
                      {semDono ? <span style={seloSemDono}>sem vínculo</span> : `CPF ${l.cpf || "-"} · ${l.responsavel}`}
                      {!semDono && !l.tem_acordo ? <span style={seloSemAcordo}>sem acordo</span> : null}
                      {!semDono && Number(l.entrou) === 0 && Number(l.baixado) > 0 ? (
                        <span style={seloSoBaixa} title="Baixa registrada sem pagamento correspondente no extrato do Santander.">
                          baixa sem lastro
                        </span>
                      ) : null}
                      {!semDono && Number(l.entrou) > 0 && Number(l.baixado) > 0
                        && Math.abs(Number(l.entrou) - Number(l.baixado)) > 0.05 ? (
                        <span style={seloDiverge} title="O valor baixado não é o valor que entrou. Pagamento à vista vem maior que o principal — confira antes de concluir.">
                          baixa ≠ extrato
                        </span>
                      ) : null}
                      {!semDono && l.quitado_em && l.ultimo_pagamento > l.quitado_em ? (
                        <span style={seloDepoisDeQuitar} title={`Quitado em ${curta(l.quitado_em)} e o pagamento entrou depois. Pode ser duplicidade, estorno a fazer ou dívida nova.`}>
                          pagou depois de quitar
                        </span>
                      ) : null}
                      {" · "}{l.qtd_pagamentos} pagamento{l.qtd_pagamentos === 1 ? "" : "s"}
                      {" · "}{l.primeiro_pagamento === l.ultimo_pagamento
                        ? curta(l.ultimo_pagamento)
                        : `${curta(l.primeiro_pagamento)} a ${curta(l.ultimo_pagamento)}`}
                    </div>
                  </td>
                  <td style={{ ...S.tdNum, fontWeight: 800, color: "#166534" }}>
                    {Number(l.entrou) > 0 ? moeda(l.entrou) : <span style={{ color: "#94a3b8" }}>—</span>}
                  </td>
                  <td style={S.tdNum}>
                    {semDono ? "—" : Number(l.baixado) > 0 ? (
                      <span title={`${l.qtd_baixas} baixa(s) no relatório`}>{moeda(l.baixado)}</span>
                    ) : <span style={{ color: "#94a3b8" }}>—</span>}
                  </td>
                  <td style={{ ...S.tdNum, fontWeight: 800 }}>{semDono ? "—" : moeda(l.saldo_aberto)}</td>
                  <td style={S.tdNum}>{semDono ? "—" : moeda(l.saldo_em_acordo)}</td>
                  <td style={S.tdNum}>{semDono ? "—" : moeda(l.saldo_em_mensalidade)}</td>
                  <td style={{ ...S.tdNum, color: Number(l.saldo_vencido) > 0 ? "#9f1239" : "#94a3b8" }}>
                    {semDono ? "—" : moeda(l.saldo_vencido)}
                  </td>
                  <td style={S.td}>
                    {vinc ? (
                      <div style={caixaConf}>
                        <input
                          autoFocus style={inputMotivo} placeholder="Buscar aluno por nome ou CPF…"
                          value={vinc.termo}
                          onChange={(e) => setVinculando({ ...vinc, termo: e.target.value })}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") procurarAluno(l, vinc.termo);
                            if (e.key === "Escape") setVinculando(null);
                          }}
                        />
                        <button type="button" style={btnOk} onClick={() => procurarAluno(l, vinc.termo)}>Buscar</button>
                        <button type="button" style={btnNao} onClick={() => setVinculando(null)}>Cancelar</button>
                        {vinc.buscando ? <span style={txtConf}>buscando…</span> : null}
                        {vinc.achados ? (
                          <div style={{ display: "flex", gap: 5, flexWrap: "wrap", width: "100%", marginTop: 4 }}>
                            {vinc.achados.map((a) => (
                              <button key={a.id} type="button" style={btnAchado} onClick={() => vincularEm(l, a.id)}>
                                {a.nome} · {a.cpf || "sem CPF"}
                              </button>
                            ))}
                            {vinc.achados.length === 0 ? (
                              <div style={{ display: "flex", gap: 5, alignItems: "center", flexWrap: "wrap", width: "100%" }}>
                                <span style={txtConf}>
                                  Nenhum aluno encontrado. Cadastrar para poder vincular:
                                </span>
                                <input
                                  style={{ ...inputMotivo, minWidth: 210 }}
                                  placeholder="Nome do aluno"
                                  value={vinc.nomeNovo ?? l.nome ?? ""}
                                  onChange={(e) => setVinculando({ ...vinc, nomeNovo: e.target.value })}
                                />
                                <input
                                  style={{ ...inputMotivo, minWidth: 140 }}
                                  placeholder="CPF (11 dígitos)"
                                  value={vinc.cpfNovo ?? ""}
                                  onChange={(e) => setVinculando({ ...vinc, cpfNovo: e.target.value })}
                                  onKeyDown={(e) => { if (e.key === "Enter") cadastrarEVincular(l); }}
                                />
                                <button type="button" style={btnOk} disabled={ocupado === chave}
                                  onClick={() => cadastrarEVincular(l)}>Cadastrar e vincular</button>
                              </div>
                            ) : null}
                          </div>
                        ) : null}
                      </div>
                    ) : conf ? (
                      <div style={caixaConf}>
                        <span style={txtConf}>
                          Registrar <b>{moeda(l.entrou)}</b> como conferido?
                          {Number(l.saldo_aberto) > 0.005 ? (
                            <> Restam <b>{moeda(l.saldo_aberto)}</b> — segue na cobrança.</>
                          ) : (
                            <> Sem saldo em aberto — o caso quita sozinho.</>
                          )}
                        </span>
                        <button type="button" style={btnOk}
                          onClick={() => aplicar(l)}>Sim</button>
                        <button type="button" style={btnNao} onClick={() => setConfirmando(null)}>Não</button>
                      </div>
                    ) : semDono ? (
                      <button type="button" style={btnVincular} disabled={ocupado === chave}
                        onClick={() => { setVinculando({ chave, termo: l.nome, achados: null }); procurarAluno(l, l.nome); }}
                        title="Achar o aluno e ligar os pagamentos a ele. (V)">
                        Vincular
                      </button>
                    ) : (
                      <button type="button" style={ocupado === chave ? S.btnBusy : S.btnConf}
                        disabled={ocupado === chave}
                        onClick={() => setConfirmando({ chave, acao: "FEITO" })}
                        title="Registra a baixa do extrato e marca como conferido. NÃO zera dívida: quem ainda deve segue na cobrança, e quem já zerou quita sozinho. (F)">Feito</button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {desfazer ? (
        <div style={toast}>
          <span>
            <b>{desfazer.linha.nome}</b> — baixa registrada e conferido.
          </span>
          <button type="button" style={btnDesfazer} onClick={desfazerAgora}>Desfazer (U)</button>
        </div>
      ) : null}

      {fichaId && (
        <div style={S.modalOverlay} onClick={() => setFichaId(null)}>
          <div style={S.modalBox} onClick={(e) => e.stopPropagation()}>
            <div style={S.modalTopo}>
              <span style={S.modalTitulo}>Ficha do aluno</span>
              <button type="button" style={{ ...S.modalFechar, marginLeft: "auto" }}
                onClick={() => setFichaId(null)}>Fechar ✕</button>
            </div>
            <div style={S.modalConteudo}><Aluno fichaEmbedId={fichaId} /></div>
          </div>
        </div>
      )}
    </div>
  );
}

const faixas = { display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", marginBottom: 10 };
const chipFaixa = {
  background: "#fff", border: "1px solid #cbd5e1", borderRadius: 999,
  padding: "5px 13px", fontSize: 12.5, fontWeight: 800, color: "#475569", cursor: "pointer",
};
const chipFaixaOn = { background: "#0f172a", borderColor: "#0f172a", color: "#fff" };
const dicaTeclado = { fontSize: 11.5, color: "#94a3b8", marginLeft: "auto" };
const rotuloGrupo = {
  fontSize: 11, fontWeight: 800, textTransform: "uppercase", letterSpacing: .6,
  color: "#94a3b8", marginRight: 2,
};
const inputData = {
  border: "1px solid #cbd5e1", borderRadius: 8, padding: "4px 9px",
  fontSize: 12, color: "#334155", background: "#fff",
};
const avisoCorte = {
  margin: "0 0 10px", fontSize: 12.5, color: "#1e3a8a", background: "#eff6ff",
  border: "1px solid #bfdbfe", borderRadius: 8, padding: "9px 13px", maxWidth: 900,
};
const linkNome = {
  background: "none", border: "none", padding: 0, cursor: "pointer",
  fontWeight: 800, fontSize: 13.5, color: "#0f172a", textAlign: "left", textDecoration: "underline",
};
const sub = { fontSize: 11.5, color: "#64748b", marginTop: 2 };
const seloSemDono = {
  fontSize: 10.5, fontWeight: 800, color: "#9a3412", background: "#ffedd5",
  border: "1px solid #fed7aa", borderRadius: 999, padding: "1px 8px", marginRight: 6,
};
const seloSoBaixa = {
  fontSize: 10.5, fontWeight: 800, color: "#7c2d12", background: "#fff7ed",
  border: "1px solid #fed7aa", borderRadius: 999, padding: "1px 8px", marginLeft: 6,
};
const seloDiverge = {
  fontSize: 10.5, fontWeight: 800, color: "#854d0e", background: "#fefce8",
  border: "1px solid #fde047", borderRadius: 999, padding: "1px 8px", marginLeft: 6,
};
const seloDepoisDeQuitar = {
  fontSize: 10.5, fontWeight: 800, color: "#9f1239", background: "#fff1f2",
  border: "1px solid #fecdd3", borderRadius: 999, padding: "1px 8px", marginLeft: 6,
};
const seloSemAcordo = {
  fontSize: 10.5, fontWeight: 800, color: "#3730a3", background: "#e0e7ff",
  border: "1px solid #c7d2fe", borderRadius: 999, padding: "1px 8px", marginLeft: 6,
};
const btnVincular = {
  background: "#9a3412", color: "#fff", border: "none", borderRadius: 8,
  padding: "5px 14px", fontSize: 12, fontWeight: 800, cursor: "pointer",
};
const caixaConf = { display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" };
const txtConf = { fontSize: 12, color: "#334155" };
const inputMotivo = { border: "1px solid #cbd5e1", borderRadius: 8, padding: "4px 9px", fontSize: 12, minWidth: 200 };
const btnOk = {
  background: "#16a34a", color: "#fff", border: "none", borderRadius: 8,
  padding: "5px 13px", fontSize: 12, fontWeight: 800, cursor: "pointer",
};
const btnNao = {
  background: "#fff", color: "#475569", border: "1px solid #cbd5e1", borderRadius: 8,
  padding: "5px 11px", fontSize: 12, fontWeight: 700, cursor: "pointer",
};
const btnAchado = {
  background: "#f1f5f9", color: "#0f172a", border: "1px solid #cbd5e1", borderRadius: 8,
  padding: "4px 10px", fontSize: 11.5, fontWeight: 700, cursor: "pointer",
};
const toast = {
  position: "fixed", left: "50%", transform: "translateX(-50%)", bottom: 26,
  background: "#0f172a", color: "#fff", borderRadius: 12, padding: "11px 16px",
  display: "flex", gap: 14, alignItems: "center", fontSize: 13,
  boxShadow: "0 10px 30px rgba(15,23,42,.35)", zIndex: 200, maxWidth: "92vw",
};
const btnDesfazer = {
  background: "#facc15", color: "#0f172a", border: "none", borderRadius: 8,
  padding: "5px 13px", fontSize: 12, fontWeight: 800, cursor: "pointer", whiteSpace: "nowrap",
};
