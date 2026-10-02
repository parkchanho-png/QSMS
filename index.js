function doPost(e) {
  try {
    var data = JSON.parse(e.postData.contents);

    if (data && data.action === "saveLayout") {
      var personName = data.targetName || "전체";
      PropertiesService.getScriptProperties().setProperty("COLUMN_LAYOUT_" + personName, JSON.stringify(data.layout));
      if (data.isShrinkFit !== undefined) {
        PropertiesService.getScriptProperties().setProperty("SHRINK_FIT_" + personName, data.isShrinkFit ? "Y" : "N");
      }
      return ContentService.createTextOutput(JSON.stringify({result: "success"})).setMimeType(ContentService.MimeType.JSON);
    }

    if (!Array.isArray(data) || data.length === 0) {
      return ContentService.createTextOutput(JSON.stringify({result: "empty", added: 0})).setMimeType(ContentService.MimeType.JSON);
    }

    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var baseSheet = ss.getSheetByName("기본");
    if (!baseSheet) baseSheet = ss.insertSheet("기본");
    baseSheet.clearContents();
    baseSheet.getRange(1, 1, data.length, data[0].length).setValues(data);

    var processedResult = processAndFormatClaimData();
    
    var listSheet = ss.getSheetByName("발송자리스트");
    if (listSheet) {
      var lastRow = listSheet.getLastRow();
      if (lastRow > 0) {
        var emailData = listSheet.getRange(1, 2, lastRow, 1).getValues();
        var emailList = [];
        for (var i = 0; i < emailData.length; i++) {
          var emailStr = String(emailData[i][0]).trim();
          if (emailStr.indexOf("@") !== -1) emailList.push(emailStr);
        }
        if (emailList.length > 0) {
          var groupEmails = emailList.join(",");
          sendTotalClaimEmail(groupEmails);
        }
      }
    }

    return ContentService.createTextOutput(JSON.stringify({
      result: "success", 
      total_rows: data.length - 1,
      sent_persons: Object.keys(processedResult).length
    })).setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({result: "error", error: err.toString()})).setMimeType(ContentService.MimeType.JSON);
  }
}

function doGet(e) {
  try {
    var targetName = (e && e.parameter && e.parameter.name) ? String(e.parameter.name).trim() : "전체";
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    
    var baseSheet = ss.getSheetByName("기본");
    if (!baseSheet) baseSheet = ss.getSheetByName("클레임"); 
    
    var rawData = baseSheet.getDataRange().getDisplayValues();
    var rawHeaders = rawData.length > 0 ? rawData[0].map(function(h) { return String(h).trim(); }) : [];
    
    var statusColIndex = rawHeaders.indexOf("접수여부");
    var progressColIndex = rawHeaders.indexOf("진행상태");
    
    var vendorColIndex = rawHeaders.indexOf("구매거래처명");
    if (vendorColIndex === -1) vendorColIndex = rawHeaders.indexOf("거래처명");

    var itemIndex = rawHeaders.indexOf("품목명");
    
    var dateCols = ["등록일시", "확인일시", "반품요청일", "반품처리일", "원주문 입고일"];
    var dateColIdxs = dateCols.map(function(c) { return rawHeaders.indexOf(c); });

    var phoneCols = ["반품전화번호", "전화번호", "휴대폰번호", "연락처"];
    var phoneColIdxs = phoneCols.map(function(c) { return rawHeaders.indexOf(c); });

    var img1Idx = rawHeaders.indexOf("반품이미지1"); if (img1Idx === -1) img1Idx = rawHeaders.indexOf("이미지1");
    var img2Idx = rawHeaders.indexOf("반품이미지2"); if (img2Idx === -1) img2Idx = rawHeaders.indexOf("이미지2");
    var img3Idx = rawHeaders.indexOf("반품이미지3"); if (img3Idx === -1) img3Idx = rawHeaders.indexOf("이미지3");
    var img4Idx = rawHeaders.indexOf("반품이미지4"); if (img4Idx === -1) img4Idx = rawHeaders.indexOf("이미지4");
    var img5Idx = rawHeaders.indexOf("반품이미지5"); if (img5Idx === -1) img5Idx = rawHeaders.indexOf("이미지5");

    var data = [];
    if(rawData.length > 0) data.push(rawHeaders);
    
    for(var i = 1; i < rawData.length; i++) {
      var row = rawData[i];
      var rawStatus = statusColIndex !== -1 ? String(row[statusColIndex]).replace(/\s+/g, "").toUpperCase() : "";
      var rawProgress = progressColIndex !== -1 ? String(row[progressColIndex]).trim() : "";
      var isProgressMatched = (progressColIndex === -1) || (rawProgress === "확인");
      
      if (rawStatus !== "Y" && isProgressMatched) {
        dateColIdxs.forEach(function(idx) {
          if (idx !== -1 && row[idx]) {
             var strVal = String(row[idx]).trim();
             var match = strVal.match(/^(\d{4})[-.\/]\s*(\d{1,2})[-.\/]\s*(\d{1,2})/);
             if (match) row[idx] = match[1] + "-" + ("0" + match[2]).slice(-2) + "-" + ("0" + match[3]).slice(-2);
          }
        });

        phoneColIdxs.forEach(function(idx) {
          if (idx !== -1 && row[idx]) {
            row[idx] = formatPhoneNumber(row[idx]);
          }
        });
        data.push(row);
      }
    }

    var nameIndex = rawHeaders.indexOf("품목담당자명");
    if (nameIndex === -1) nameIndex = 0;
    var rtnIndex = rawHeaders.indexOf("반품번호");

    if (data.length > 1) {
      var headerRow = data[0];
      var dataRows = data.slice(1);
      dataRows.sort(function(a, b) {
        var nameA = String(a[nameIndex]).trim();
        var nameB = String(b[nameIndex]).trim();
        var cmp = nameA.localeCompare(nameB, 'ko');
        if (cmp === 0 && itemIndex !== -1) {
          var itemA = String(a[itemIndex]).trim();
          var itemB = String(b[itemIndex]).trim();
          return itemA.localeCompare(itemB, 'ko');
        }
        return cmp;
      });
      data = [headerRow].concat(dataRows);
    }

    var vendorList = [];
    for (var i = 1; i < data.length; i++) {
      var rowName = String(data[i][nameIndex]).trim();
      if (targetName === "전체" || rowName === targetName) {
        if (vendorColIndex !== -1 && data[i][vendorColIndex]) {
          var vName = String(data[i][vendorColIndex]).trim();
          if (vName && vendorList.indexOf(vName) === -1) {
            vendorList.push(vName);
          }
        }
      }
    }
    vendorList.sort();

    var defaultWidths = {
      "품목담당자명": 80, "반품번호": 130, "등록일시": 85, "거래처코드": 75, "거래처명": 150, 
      "반품전화번호": 110, "품목코드": 90, "품목명": 220, "요청내역": 350, "수량": 45, "확인자명": 80, "확인일시": 85,
      "반품이미지1": 65, "반품이미지2": 65, "반품이미지3": 65, "반품이미지4": 65, "반품이미지5": 65
    };

    var savedLayoutRaw = PropertiesService.getScriptProperties().getProperty("COLUMN_LAYOUT_" + targetName);
    var savedLayout = savedLayoutRaw ? JSON.parse(savedLayoutRaw) : null;
    
    var shrinkFitRaw = PropertiesService.getScriptProperties().getProperty("SHRINK_FIT_" + targetName);
    var isShrinkFit = (shrinkFitRaw === "Y"); 

    if (!savedLayout || !Array.isArray(savedLayout)) {
      var targetColumns = ["품목담당자명", "반품번호", "등록일시", "거래처코드", "거래처명", "반품전화번호", "품목코드", "품목명", "요청내역", "수량", "확인자명", "확인일시"];
      savedLayout = rawHeaders.map(function(h) { 
        return { name: h, visible: targetColumns.indexOf(h) !== -1, width: defaultWidths[h] || 100 }; 
      });
      savedLayout.sort(function(a, b) {
        var idxA = targetColumns.indexOf(a.name);
        var idxB = targetColumns.indexOf(b.name);
        if (idxA !== -1 && idxB !== -1) return idxA - idxB;
        if (idxA !== -1) return -1;
        if (idxB !== -1) return 1;
        return 0;
      });
    } else {
      var existingNames = savedLayout.map(function(item) { return item.name.trim(); });
      rawHeaders.forEach(function(h) {
        if (existingNames.indexOf(h) === -1) {
          savedLayout.push({ name: h, visible: false, width: defaultWidths[h] || 100 });
        }
      });
      savedLayout.forEach(function(item) {
        item.name = item.name.trim();
        if (!item.width || item.width < 15) item.width = defaultWidths[item.name] || 100;
      });
    }

    var displayCols = [];
    savedLayout.forEach(function(item) {
      if (item.visible) {
        var idx = rawHeaders.indexOf(item.name);
        if (idx !== -1) {
          displayCols.push({ idx: idx, name: item.name, width: item.width });
        }
      }
    });

    var rawUrl = ScriptApp.getService().getUrl();
    var webAppUrl = rawUrl ? rawUrl.replace(/\/u\/\d+\//, "/") : "";

    var html = "<style>" +
      ".resizer { width: 6px; height: 100%; position: absolute; right: 0; top: 0; cursor: col-resize; user-select: none; z-index: 10; transition: background-color 0.2s; }" +
      ".resizer:hover { background-color: #3498db; }" +
      "th { position: relative; transition: opacity 0.2s; overflow: hidden; box-sizing: border-box; }" +
      ".drag-handle { cursor: grab; padding-bottom: 5px; user-select: none; }" +
      ".drag-handle:active { cursor: grabbing; }" +
      "th.over { border: 2px dashed #e74c3c !important; opacity: 0.7; }" +
      "body { margin: 0; background-color: #f8f9fa; }" +
      "td { box-sizing: border-box; overflow: hidden; }" +
      ".cell-content { font-size: 13px; line-height: 1.4; word-break: break-all; word-wrap: break-word; transition: font-size 0.1s; }" +
      ".claim-data-row:hover { background-color: #eaf2f8 !important; }" +
      ".claim-data-row.selected-row { background-color: #e8f8f5 !important; font-weight: bold; }" +
      "</style>";

    html += "<div style='font-family: \"Malgun Gothic\", sans-serif; padding: 20px; width: 95%; margin: 0 auto; background: #fff; box-shadow: 0 0 10px rgba(0,0,0,0.1); border-radius: 8px; margin-top: 20px;'>";
    
    html += "<div style='display: flex; justify-content: space-between; align-items: center; border-bottom: 2px solid #3498db; padding-bottom: 12px; margin-bottom: 20px; flex-wrap: wrap; gap: 15px;'>";
    
    html += "<div style='display: flex; align-items: center; gap: 20px; flex-wrap: wrap;'>";
    html += "<h2 style='color: #2c3e50; margin: 0;'>📊 " + targetName + " 담당자 클레임 내역</h2>";
    
    html += "<div style='display: flex; flex-direction: column; gap: 8px; margin-left: 10px;'>";
    html += "<label style='font-size: 13px; font-weight: bold; cursor: pointer; display: flex; align-items: center; gap: 6px; color: #2c3e50;'>" +
            "<input type='checkbox' id='shrinkCheck' onchange='toggleShrinkToFit()' " + (isShrinkFit ? "checked" : "") + " style='transform: scale(1.2); cursor: pointer; margin: 0;'>" +
            "셀크기에 맞춰 폰트수정</label>";
    html += "</div></div>";

    html += "<div style='display: flex; gap: 8px; align-items: center; flex-wrap: wrap;'>";
    
    html += "<select id='vendorSelect' onchange='filterTableMulti()' style='padding: 7px 10px; font-size: 13px; border: 1px solid #3498db; border-radius: 6px; outline: none; background: #fff; cursor: pointer; color: #2c3e50; font-weight: bold;'>" +
            "<option value=''>🏢 전체 구매거래처</option>";
    vendorList.forEach(function(v) {
      html += "<option value='" + v + "'>" + v + "</option>";
    });
    html += "<option value='__NONE__'>❌ 거래처 없음</option>";
    html += "</select>";

    html += "<button onclick='autoFitColumns()' style='padding: 8px 12px; font-size: 13px; background-color: #3498db; color: #fff; border: none; border-radius: 6px; cursor: pointer; font-weight: bold;'>✨ 열너비 자동맞춤</button>";
    html += "<button onclick='copyForEmail()' style='padding: 8px 12px; font-size: 13px; background-color: #8e44ad; color: #fff; border: none; border-radius: 6px; cursor: pointer; font-weight: bold;'>📋 메일용 복사</button>";
    html += "<button onclick='exportToExcel()' style='padding: 8px 12px; font-size: 13px; background-color: #27ae60; color: #fff; border: none; border-radius: 6px; cursor: pointer; font-weight: bold;'>📥 엑셀 다운로드</button>";
    html += "<button onclick='openModal()' style='padding: 8px 12px; font-size: 13px; background-color: #7f8c8d; color: #fff; border: none; border-radius: 6px; cursor: pointer; font-weight: bold;'>👁️ 열 꺼내기 / 숨기기</button>";
    html += "<button onclick='saveLayoutToServer(false)' id='saveBtnMain' style='padding: 8px 12px; font-size: 13px; background-color: #2c3e50; color: #fff; border: none; border-radius: 6px; cursor: pointer; font-weight: bold;'>💾 현재 서식 저장</button>";

    html += "</div></div>";

    if (data.length > 1) {
      html += "<div style='overflow-x: auto; width: 100%; border-radius: 8px; border: 1px solid #eee;'>";
      html += "<table id='claimTable' style='border-collapse: collapse; width: max-content; font-size: 13px; text-align: center; table-layout: fixed;' border='1'>";
      html += "<thead style='background-color: #f2f2f2; font-weight: bold;'><tr>";

      displayCols.forEach(function(col, index) {
        html += "<th data-col-name='" + col.name + "' data-width='" + col.width + "' style='padding: 10px 5px; border: 1px solid #ddd; vertical-align: top; width: " + col.width + "px; min-width: " + col.width + "px; max-width: " + col.width + "px; box-sizing: border-box;'>";
        html += "<div class='drag-handle' title='마우스로 꾹 눌러서 끌면 순서가 바뀝니다.' onmouseenter='this.parentNode.setAttribute(\"draggable\", \"true\")' onmouseleave='this.parentNode.setAttribute(\"draggable\", \"false\")'>" + col.name + "</div>";
        html += "<input type='text' size='1' class='col-filter' data-idx='" + index + "' onkeyup='filterTableMulti()' placeholder='검색' style='width: 100%; min-width: 0; max-width: 100%; box-sizing: border-box; padding: 4px; font-size: 11px; border: 1px solid #ccc; border-radius: 4px; text-align: center; outline: none; margin-top: 5px;'>";
        html += "<div class='resizer' title='드래그하여 크기 조절'></div>";
        html += "</th>";
      });
      html += "</tr></thead><tbody id='tableBody'>";

      var count = 0;
      for (var i = 1; i < data.length; i++) {
        var rowName = String(data[i][nameIndex]).trim();
        if (targetName === "전체" || rowName === targetName) {
          var rowVendorVal = (vendorColIndex !== -1 && data[i][vendorColIndex] !== undefined) ? String(data[i][vendorColIndex]).trim() : "";
          var rowItemVal = (itemIndex !== -1 && data[i][itemIndex] !== undefined) ? String(data[i][itemIndex]).trim() : "";

          var img1Val = (img1Idx !== -1 && data[i][img1Idx]) ? String(data[i][img1Idx]).trim() : "";
          var img2Val = (img2Idx !== -1 && data[i][img2Idx]) ? String(data[i][img2Idx]).trim() : "";
          var img3Val = (img3Idx !== -1 && data[i][img3Idx]) ? String(data[i][img3Idx]).trim() : "";
          var img4Val = (img4Idx !== -1 && data[i][img4Idx]) ? String(data[i][img4Idx]).trim() : "";
          var img5Val = (img5Idx !== -1 && data[i][img5Idx]) ? String(data[i][img5Idx]).trim() : "";
          
          html += "<tr onclick='showImagePreview(this, event)' class='claim-data-row' " +
                  "data-vendor-name='" + rowVendorVal.replace(/'/g, "&apos;").replace(/"/g, "&quot;") + "' " +
                  "data-item-name='" + rowItemVal.replace(/'/g, "&apos;").replace(/"/g, "&quot;") + "' " +
                  "data-img1='" + img1Val.replace(/'/g, "&apos;").replace(/"/g, "&quot;") + "' " +
                  "data-img2='" + img2Val.replace(/'/g, "&apos;").replace(/"/g, "&quot;") + "' " +
                  "data-img3='" + img3Val.replace(/'/g, "&apos;").replace(/"/g, "&quot;") + "' " +
                  "data-img4='" + img4Val.replace(/'/g, "&apos;").replace(/"/g, "&quot;") + "' " +
                  "data-img5='" + img5Val.replace(/'/g, "&apos;").replace(/"/g, "&quot;") + "' " +
                  "style='cursor: pointer; background-color: " + (count % 2 === 0 ? "#fff" : "#f9f9f9") + ";'>";
          
          displayCols.forEach(function(col) {
            var alignLeft = (col.name === "요청내역" || col.name === "품목명" || col.name === "거래처명");
            var textAlign = alignLeft ? "left" : "center";
            var padding = alignLeft ? "8px 10px" : "8px 5px";
            var cellValue = (data[i] && data[i][col.idx] !== undefined) ? String(data[i][col.idx]).trim() : ""; 
            
            // 💡 [핵심 구현] 이미지 열 셀 내부에 <a href="..."> 태그를 도메인이 포함된 전체 URL로 확실하게 포함
            var cellDisplayHtml = cellValue;
            if (col.name.indexOf("반품이미지") !== -1 || col.name.indexOf("이미지") !== -1) {
              if (cellValue !== "") {
                var imgNum = col.name.replace(/[^0-9]/g, "") || "1";
                var fullUrl = cellValue;
                if (fullUrl.indexOf("http") !== 0) {
                  fullUrl = "https://gw.theborn.co.kr" + (fullUrl.indexOf("/") === 0 ? "" : "/") + fullUrl;
                }
                cellDisplayHtml = "<a href='" + fullUrl + "' target='_blank' style='color: #0056b3; font-weight: bold; text-decoration: underline;'>사진" + imgNum + "</a>";
              } else {
                cellDisplayHtml = "";
              }
            }

            html += "<td style='padding: " + padding + "; border: 1px solid #ddd; text-align: " + textAlign + "; width: " + col.width + "px; min-width: " + col.width + "px; max-width: " + col.width + "px; box-sizing: border-box;'>" +
                    "<div class='cell-content' style='width: 100%;'>" + cellDisplayHtml + "</div></td>";
          });
          html += "</tr>";
          count++;
        }
      }
      html += "</tbody></table></div>";
      
      if (count === 0) {
        html += "<p style='margin-top: 20px; color: #e74c3c; font-weight: bold;'>조회된 클레임 내역이 없습니다.</p>";
      }
    } else {
      html += "<p style='margin-top: 20px;'>데이터가 없습니다.</p>";
    }
    
    html += "<div id='imagePreviewArea' style='display:none; margin-top: 20px; padding: 20px; border: 2px solid #3498db; border-radius: 8px; background: #fafafa; box-shadow: 0 4px 12px rgba(0,0,0,0.08); min-height: 320px; box-sizing: border-box;'>" +
      "<div style='display: flex; justify-content: space-between; align-items: center; border-bottom: 2px solid #3498db; padding-bottom: 10px; margin-bottom: 15px;'>" +
      "<h3 id='previewTitle' style='margin:0; color:#2c3e50; font-size:16px;'>📷 첨부 이미지 미리보기</h3>" +
      "<button onclick='closePreviewArea()' style='padding:5px 12px; font-size:12px; background:#7f8c8d; color:#fff; border:none; border-radius:4px; cursor:pointer; font-weight:bold;'>✕ 미리보기 닫기</button>" +
      "</div>" +
      "<div id='previewImagesContainer' style='display: flex; gap: 20px; overflow-x: auto; padding: 10px 0; height: 240px; align-items: center;'>" +
      "</div>" +
      "</div>";

    html += "<div id='layoutModal' style='display:none; position:fixed; top:0; left:0; width:100%; height:100%; background:rgba(0,0,0,0.6); z-index:9999; align-items:center; justify-content:center;'>" +
      "<div style='background:#fff; padding:20px 25px; border-radius:10px; width:380px; max-height:85vh; display:flex; flex-direction:column; box-shadow:0 4px 15px rgba(0,0,0,0.3);'>" +
      "<div style='display:flex; justify-content:space-between; align-items:center; border-bottom:2px solid #3498db; padding-bottom:10px; margin-bottom:15px;'>" +
      "<h3 style='margin:0; color:#2c3e50;'>👁️ 추가 열 꺼내기/숨기기</h3>" +
      "<button onclick='saveLayoutToServer(true)' id='saveBtnModal' style='padding:6px 12px; font-size:12px; background-color:#e74c3c; color:#fff; border:none; border-radius:5px; cursor:pointer; font-weight:bold;'>💾 닫고 적용하기</button>" +
      "</div>" +
      "<p style='font-size:12px; color:#666; margin-bottom:15px; line-height:1.4;'>체크박스를 클릭하여 원하는 열을 화면에 표시하세요.<br/>설정 후 반드시 우측 상단의 <b>[적용하기]</b>를 눌러주세요.</p>" +
      "<div style='overflow-y:auto; flex-grow:1; margin-bottom:15px; border:1px solid #eee; border-radius:5px; padding:10px;'>" +
      "<ul id='layoutList' style='list-style:none; padding:0; margin:0;'></ul>" +
      "</div>" +
      "<div style='text-align:right; border-top:1px solid #eee; padding-top:15px;'>" +
      "<button onclick='closeModal()' style='padding:8px 15px; border:1px solid #ccc; background:#f5f5f5; border-radius:5px; cursor:pointer;'>취소 (닫기)</button>" +
      "</div>" +
      "</div></div>";

    html += "<script>" +
      "var layout = " + JSON.stringify(savedLayout) + ";" +
      "var targetName = '" + targetName + "';" +
      "var webAppUrl = '" + webAppUrl + "';" +
      
      "function showToast(msg) {" +
      "  var toast = document.getElementById('toastMsg');" +
      "  if (!toast) {" +
      "    toast = document.createElement('div');" +
      "    toast.id = 'toastMsg';" +
      "    toast.style.cssText = 'position:fixed; bottom:30px; left:50%; transform:translateX(-50%); background:rgba(44,62,80,0.95); color:#fff; padding:12px 24px; border-radius:30px; font-size:13px; font-weight:bold; z-index:10000; box-shadow:0 4px 15px rgba(0,0,0,0.2); transition:opacity 0.3s; opacity:0; pointer-events:none; font-family:\"Malgun Gothic\", sans-serif;';" +
      "    document.body.appendChild(toast);" +
      "  }" +
      "  toast.innerText = msg;" +
      "  toast.style.opacity = '1';" +
      "  setTimeout(function() { toast.style.opacity = '0'; }, 2500);" +
      "}" +

      "function openModal() { renderLayoutList(); document.getElementById('layoutModal').style.display = 'flex'; }" +
      "function closeModal() { document.getElementById('layoutModal').style.display = 'none'; }" +
      
      "function renderLayoutList() {" +
      "  var ul = document.getElementById('layoutList'); ul.innerHTML = '';" +
      "  layout.forEach(function(item, idx) {" +
      "    var li = document.createElement('li');" +
      "    li.style.cssText = 'display:flex; align-items:center; padding:8px 5px; border-bottom:1px solid #f9f9f9;';" +
      "    li.innerHTML = \"<input type='checkbox' id='chk_\" + idx + \"' \" + (item.visible ? 'checked' : '') + \" onchange='layout[\" + idx + \"].visible = this.checked' style='cursor:pointer; transform:scale(1.2); margin-right:10px;'> \" +" +
      "                   \"<label for='chk_\" + idx + \"' style='font-weight:bold; font-size:13px; cursor:pointer; color:#333; width:100%;'>\" + item.name + \"</label>\";" +
      "    ul.appendChild(li);" +
      "  });" +
      "}" +

      "function updateLayoutFromDOM() {" +
      "  var ths = document.querySelectorAll('#claimTable th');" +
      "  var newLayout = [];" +
      "  var seenNames = {};" +
      "  ths.forEach(function(th) {" +
      "    var colName = th.getAttribute('data-col-name');" +
      "    if (colName) {" +
      "      colName = colName.trim();" +
      "      var explicitW = parseInt(th.getAttribute('data-width')) || parseInt(th.style.width) || 100;" +
      "      newLayout.push({ name: colName, visible: true, width: Math.max(15, Math.floor(explicitW)) });" +
      "      seenNames[colName] = true;" +
      "    }" +
      "  });" +
      "  layout.forEach(function(item) {" +
      "    var trimmedName = item.name.trim();" +
      "    if (!seenNames[trimmedName]) {" +
      "      newLayout.push({ name: trimmedName, visible: item.visible, width: item.width || 100 });" +
      "      seenNames[trimmedName] = true;" +
      "    }" +
      "  });" +
      "  layout = newLayout;" +
      "}" +
      
      "function saveLayoutToServer(isFromModal) {" +
      "  if (!isFromModal) updateLayoutFromDOM();" +
      "  var btn = isFromModal ? document.getElementById('saveBtnModal') : document.getElementById('saveBtnMain');" +
      "  var originalText = btn.innerText;" +
      "  btn.innerText = '⏳ 저장 중...'; btn.disabled = true;" +
      "  var isShrinkFit = document.getElementById('shrinkCheck').checked;" +
      "  var layoutStr = JSON.stringify(layout);" +
      
      "  if (typeof google !== 'undefined' && google.script && google.script.run) {" +
      "    google.script.run" +
      "      .withSuccessHandler(function(res) {" +
      "        showToast('✅ 서식이 성공적으로 저장되었습니다!');" +
      "        setTimeout(function() { window.top.location.href = webAppUrl + '?name=' + encodeURIComponent(targetName); }, 500);" +
      "      })" +
      "      .withFailureHandler(function(err) {" +
      "        showToast('❌ 통신 오류가 발생했습니다.');" +
      "        btn.innerText = originalText; btn.disabled = false;" +
      "      })" +
      "      .saveUserLayoutApp(targetName, layoutStr, isShrinkFit);" +
      "  } else {" +
      "    showToast('⚠️ 구글 서버 연결 실패');" +
      "    btn.innerText = originalText; btn.disabled = false;" +
      "  }" +
      "}" +

      "function toggleShrinkToFit() { adjustFontSizes(); }" +

      "function autoFitColumns() {" +
      "  var ths = document.querySelectorAll('#claimTable th');" +
      "  var tbodyTrs = document.querySelectorAll('#claimTable tbody tr');" +
      
      "  var span = document.createElement('span');" +
      "  span.style.visibility = 'hidden';" +
      "  span.style.position = 'absolute';" +
      "  span.style.top = '-9999px';" +
      "  span.style.whiteSpace = 'nowrap';" +
      "  document.body.appendChild(span);" +

      "  ths.forEach(function(th, colIdx) {" +
      "    if(th.style.display === 'none') return;" +
      "    var handle = th.querySelector('.drag-handle');" +
      "    var titleText = handle ? handle.innerText.trim() : '';" +
      "    span.style.font = 'bold 13px \"Malgun Gothic\", sans-serif';" +
      "    span.innerText = titleText;" +
      "    var maxWidth = span.offsetWidth + 30;" +
      
      "    span.style.font = '13px \"Malgun Gothic\", sans-serif';" +
      "    tbodyTrs.forEach(function(tr) {" +
      "      if (tr.style.display !== 'none') {" +
      "        var td = tr.children[colIdx];" +
      "        if (td) {" +
      "          var content = td.querySelector('.cell-content');" +
      "          if (content) {" +
      "            span.innerText = content.innerText.trim();" +
      "            var w = span.offsetWidth + 24;" +
      "            if (w > maxWidth) maxWidth = w;" +
      "          }" +
      "        }" +
      "      }" +
      "    });" +
      "    maxWidth = Math.max(maxWidth, 45);" +
      
      "    th.style.width = maxWidth + 'px';" +
      "    th.style.minWidth = maxWidth + 'px';" +
      "    th.style.maxWidth = maxWidth + 'px';" +
      "    th.setAttribute('data-width', maxWidth);" +
      "    tbodyTrs.forEach(function(tr) {" +
      "      var td = tr.children[colIdx];" +
      "      if (td) {" +
      "        td.style.width = maxWidth + 'px';" +
      "        td.style.minWidth = maxWidth + 'px';" +
      "        td.style.maxWidth = maxWidth + 'px';" +
      "      }" +
      "    });" +
      "  });" +
      "  document.body.removeChild(span);" +
      "  updateLayoutFromDOM();" +
      "  adjustFontSizes();" +
      "  showToast('✨ 현재 내용에 맞게 열너비가 자동맞춤 되었습니다.');" +
      "}" +

      "function adjustFontSizes() {" +
      "  var isShrink = document.getElementById('shrinkCheck').checked;" +
      "  var tds = document.querySelectorAll('#claimTable tbody td');" +
      "  tds.forEach(function(td) {" +
      "    var content = td.querySelector('.cell-content');" +
      "    if (!content) return;" +
      "    if (!isShrink) {" +
      "      content.style.fontSize = '13px';" +
      "      content.style.whiteSpace = 'normal';" +
      "      content.style.wordBreak = 'break-all';" +
      "      return;" +
      "    }" +
      "    content.style.fontSize = '13px';" + 
      "    content.style.whiteSpace = 'nowrap';" +
      "    content.style.wordBreak = 'normal';" +
      
      "    var oldDisplay = content.style.display;" +
      "    var oldWidth = content.style.width;" +
      "    content.style.display = 'inline-block';" +
      "    content.style.width = 'max-content';" +
      "    var actual = content.offsetWidth;" +
      
      "    var comp = window.getComputedStyle(td);" +
      "    var padLeft = parseFloat(comp.paddingLeft) || 0;" +
      "    var padRight = parseFloat(comp.paddingRight) || 0;" +
      "    var available = td.clientWidth - (padLeft + padRight) - 4;" + 
      
      "    if (actual > available && available > 0) {" +
      "       var scale = available / actual;" +
      "       var newSize = Math.max(7, Math.floor(13 * scale * 96) / 100);" +
      "       content.style.fontSize = newSize + 'px';" +
      "    }" +
      
      "    content.style.display = oldDisplay;" +
      "    content.style.width = oldWidth;" +
      "  });" +
      "}" +

      "function filterTableMulti() {" +
      "  var tbody = document.getElementById('tableBody');" +
      "  if (!tbody) return;" +
      "  var tr = tbody.getElementsByTagName('tr');" +
      "  var inputs = document.getElementsByClassName('col-filter');" +
      "  var vendorSel = document.getElementById('vendorSelect');" +
      "  var selectedVendor = vendorSel ? vendorSel.value.toLowerCase().trim() : '';" +
      "  var visibleCount = 0;" + 
      "  var firstVisibleTr = null;" +

      "  for (var i = 0; i < tr.length; i++) {" +
      "    var showRow = true;" +
      "    if (selectedVendor !== '') {" +
      "      var rowVendor = (tr[i].getAttribute('data-vendor-name') || '').toLowerCase().trim();" +
      "      if (selectedVendor === '__none__') {" +
      "        if (rowVendor !== '') showRow = false;" +
      "      } else if (rowVendor !== selectedVendor) {" +
      "        showRow = false;" +
      "      }" +
      "    }" +
      "    if (showRow) {" +
      "      var tdList = tr[i].getElementsByTagName('td');" +
      "      for (var j = 0; j < inputs.length; j++) {" +
      "        var filterVal = inputs[j].value.toLowerCase().trim();" +
      "        var colIdx = inputs[j].getAttribute('data-idx');" +
      "        if (filterVal !== '') {" +
      "          var cellText = tdList[colIdx] ? tdList[colIdx].textContent.toLowerCase() : '';" +
      "          if (cellText.indexOf(filterVal) === -1) {" +
      "            showRow = false; break;" +
      "          }" +
      "        }" +
      "      }" +
      "    }" +
      "    tr[i].style.display = showRow ? '' : 'none';" +
      "    if (showRow) {" +
      "      if (!firstVisibleTr) firstVisibleTr = tr[i];" +
      "      if (!tr[i].classList.contains('selected-row')) {" +
      "        tr[i].style.backgroundColor = (visibleCount % 2 === 0) ? '#fff' : '#f9f9f9';" + 
      "      }" +
      "      visibleCount++;" +
      "    }" +
      "  }" +
      "  adjustFontSizes();" +

      "  if (firstVisibleTr) {" +
      "    showImagePreview(firstVisibleTr, null);" +
      "  } else {" +
      "    closePreviewArea();" +
      "  }" +
      "}" +

      "function showImagePreview(tr, e) {" +
      "  if (e && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.className.indexOf('resizer') > -1)) {" +
      "    return;" +
      "  }" +
      "  var allRows = document.querySelectorAll('.claim-data-row');" +
      "  var visibleIdx = 0;" +
      "  allRows.forEach(function(r) {" +
      "    if (r.style.display !== 'none') {" +
      "      r.style.backgroundColor = (visibleIdx % 2 === 0) ? '#fff' : '#f9f9f9';" +
      "      visibleIdx++;" +
      "    }" +
      "    r.classList.remove('selected-row');" +
      "  });" +
      "  tr.style.backgroundColor = '#e8f8f5';" +
      "  tr.classList.add('selected-row');" +

      "  var vendorName = tr.getAttribute('data-vendor-name') || '';" +
      "  var itemName = tr.getAttribute('data-item-name') || '';" +
      "  var previewArea = document.getElementById('imagePreviewArea');" +
      "  var previewTitle = document.getElementById('previewTitle');" +
      "  var container = document.getElementById('previewImagesContainer');" +

      "  previewTitle.innerText = '📷 첨부 이미지 미리보기 - ' + (vendorName ? '[' + vendorName + '] ' : '') + itemName;" +
      "  container.innerHTML = '';" +

      "  var hasImg = false;" +
      "  for (var i = 1; i <= 5; i++) {" +
      "    var imgUrl = tr.getAttribute('data-img' + i);" +
      "    if (imgUrl && imgUrl.trim() !== '') {" +
      "      hasImg = true;" +
      "      var fullUrl = imgUrl.trim();" +
      "      if (fullUrl.indexOf('http') !== 0) {" +
      "        fullUrl = 'https://gw.theborn.co.kr' + (fullUrl.indexOf('/') === 0 ? '' : '/') + fullUrl;" +
      "      }" +
      "      var card = document.createElement('div');" +
      "      card.style.cssText = 'text-align: center; background: #fff; padding: 10px; border: 1px solid #ddd; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.08); flex-shrink: 0; width: 260px; height: 220px; box-sizing: border-box; display: flex; flex-direction: column; align-items: center; justify-content: center;';" +
      
      "      var label = document.createElement('div');" +
      "      label.style.cssText = 'font-size: 13px; font-weight: bold; color: #2980b9; margin-bottom: 6px;';" +
      "      label.innerText = '사진 ' + i;" +

      "      var a = document.createElement('a');" +
      "      a.href = fullUrl;" +
      "      a.target = '_blank';" +
      "      a.title = '클릭하시면 새 탭에서 원본 크기로 열립니다.';" +

      "      var img = document.createElement('img');" +
      "      img.src = fullUrl;" +
      "      img.style.cssText = 'height: 170px; width: 230px; border-radius: 4px; object-fit: contain; display: block; cursor: pointer; border: 1px solid #eee; background: #fff;';" +

      "      a.appendChild(img);" +
      "      card.appendChild(label);" +
      "      card.appendChild(a);" +
      "      container.appendChild(card);" +
      "    }" +
      "  }" +

      "  if (!hasImg) {" +
      "    container.innerHTML = '<p style=\"color: #7f8c8d; font-size: 13px; margin: 25px 0; font-weight: bold;\">📷 등록된 반품 이미지가 없는 클레임 건입니다.</p>';" +
      "  }" +

      "  previewArea.style.display = 'block';" +
      "}" +

      "function closePreviewArea() {" +
      "  var previewArea = document.getElementById('imagePreviewArea');" +
      "  if (previewArea) previewArea.style.display = 'none';" +
      "  var allRows = document.querySelectorAll('.claim-data-row');" +
      "  var visibleIdx = 0;" +
      "  allRows.forEach(function(r) {" +
      "    if (r.style.display !== 'none') {" +
      "      r.style.backgroundColor = (visibleIdx % 2 === 0) ? '#fff' : '#f9f9f9';" +
      "      visibleIdx++;" +
      "    }" +
      "    r.classList.remove('selected-row');" +
      "  });" +
      "}" +

      // 💡 [핵심] <a href="..."> 태그 구조 및 absolute URL을 그대로 보존하여 복사
      "function copyForEmail() {" +
      "  var table = document.getElementById('claimTable');" +
      "  if (!table) return;" +
      
      "  var originalThs = table.querySelectorAll('thead th');" +
      "  var colWidths = [];" +
      "  var totalWidth = 0;" +
      "  originalThs.forEach(function(th) {" +
      "    if (th.style.display !== 'none') {" +
      "      var w = th.offsetWidth || parseInt(th.style.width) || parseInt(th.getAttribute('data-width')) || 100;" +
      "      colWidths.push(w);" +
      "      totalWidth += w;" +
      "    }" +
      "  });" +

      "  var cloneTable = table.cloneNode(true);" +
      "  var trs = cloneTable.querySelectorAll('tr');" +
      "  trs.forEach(function(tr) {" +
      "    if (tr.style.display === 'none') tr.parentNode.removeChild(tr);" +
      "    tr.removeAttribute('style');" +
      "  });" +
      "  var removeEls = cloneTable.querySelectorAll('.col-filter, .resizer');" +
      "  removeEls.forEach(function(el) { el.parentNode.removeChild(el); });" +
      
      "  cloneTable.style.width = totalWidth + 'px';" +
      "  cloneTable.style.minWidth = totalWidth + 'px';" +
      "  cloneTable.style.tableLayout = 'fixed';" +
      "  cloneTable.style.borderCollapse = 'collapse';" +
      "  cloneTable.style.fontSize = '12px';" +
      "  cloneTable.style.fontFamily = '\"Malgun Gothic\", sans-serif';" +
      "  cloneTable.removeAttribute('id');" +
      
      "  var ths = cloneTable.querySelectorAll('th');" +
      "  ths.forEach(function(th, idx) {" +
      "    var handle = th.querySelector('.drag-handle');" +
      "    if (handle) th.innerHTML = handle.innerHTML;" +
      "    th.removeAttribute('draggable');" +
      "    var w = colWidths[idx] || 100;" +
      "    th.style.cssText = 'width: ' + w + 'px; min-width: ' + w + 'px; max-width: ' + w + 'px; background-color: #f2f2f2; border: 1px solid #ccc; padding: 6px 8px; text-align: center; font-weight: bold; box-sizing: border-box; word-break: break-all; color: #333;';" +
      "  });" +
      
      "  var tbodyTrs = cloneTable.querySelectorAll('tbody tr');" +
      "  tbodyTrs.forEach(function(tr, rIdx) {" +
      "    tr.style.backgroundColor = (rIdx % 2 === 0) ? '#ffffff' : '#f9f9f9';" +
      "    var tds = tr.querySelectorAll('td');" +
      "    tds.forEach(function(td, idx) {" +
      "      var align = td.style.textAlign || 'center';" +
      "      var content = td.querySelector('.cell-content');" +
      "      var textVal = content ? content.innerHTML : td.innerHTML;" +
      "      var w = colWidths[idx] || 100;" +
      "      td.innerHTML = textVal;" +
      "      td.style.cssText = 'width: ' + w + 'px; min-width: ' + w + 'px; max-width: ' + w + 'px; border: 1px solid #ccc; padding: 6px 8px; text-align: ' + align + '; box-sizing: border-box; word-break: break-all; color: #333; font-weight: normal;';" +
      "    });" +
      "  });" +
      
      "  var htmlContent = cloneTable.outerHTML;" +
      "  if (navigator.clipboard && window.ClipboardItem) {" +
      "    var blobHtml = new Blob([htmlContent], { type: 'text/html' });" +
      "    var blobText = new Blob([cloneTable.innerText], { type: 'text/plain' });" +
      "    var item = new ClipboardItem({ 'text/html': blobHtml, 'text/plain': blobText });" +
      "    navigator.clipboard.write([item]).then(function() {" +
      "      showToast('📋 메일용 서식이 사진 하이퍼링크와 함께 복사되었습니다! [Ctrl + V]로 붙여넣으세요.');" +
      "    }).catch(function() { fallbackCopyHTML(htmlContent); });" +
      "  } else {" +
      "    fallbackCopyHTML(htmlContent);" +
      "  }" +
      "}" +

      "function fallbackCopyHTML(html) {" +
      "  var container = document.createElement('div');" +
      "  container.innerHTML = html;" +
      "  container.style.position = 'fixed'; container.style.opacity = '0';" +
      "  document.body.appendChild(container);" +
      "  var sel = window.getSelection(); var range = document.createRange();" +
      "  range.selectNodeContents(container); sel.removeAllRanges(); sel.addRange(range);" +
      "  try {" +
      "    document.execCommand('copy');" +
      "    showToast('📋 메일용 서식이 사진 하이퍼링크와 함께 복사되었습니다! [Ctrl + V]로 붙여넣으세요.');" +
      "  } catch(e) { showToast('❌ 복사 실패'); }" +
      "  document.body.removeChild(container);" +
      "}" +

      "function exportToExcel() {" +
      "  var table = document.getElementById('claimTable');" +
      "  if (!table) return;" +
      "  var rows = table.querySelectorAll('tr');" +
      "  var csv = [];" +
      "  for (var i = 0; i < rows.length; i++) {" +
      "    if (rows[i].style.display === 'none') continue;" +
      "    var row = [], cols = rows[i].querySelectorAll('td, th');" +
      "    for (var j = 0; j < cols.length; j++) {" +
      "      var text = '';" +
      "      if (rows[i].parentNode.tagName.toLowerCase() === 'thead') {" +
      "        var headerDiv = cols[j].querySelector('.drag-handle');" +
      "        if (headerDiv) text = headerDiv.innerText;" +
      "      } else {" +
      "        var contentDiv = cols[j].querySelector('.cell-content');" +
      "        text = contentDiv ? contentDiv.innerText : cols[j].innerText;" +
      "      }" +
      "      text = text.replace(/\"/g, '\"\"');" +
      "      row.push('\"' + text + '\"');" +
      "    }" +
      "    csv.push(row.join(','));" +
      "  }" +
      "  var csvString = '\\uFEFF' + csv.join('\\r\\n');" +
      "  var blob = new Blob([csvString], { type: 'text/csv;charset=utf-8;' });" +
      "  var link = document.createElement('a');" +
      "  var url = URL.createObjectURL(blob);" +
      "  link.setAttribute('href', url);" +
      "  var today = new Date();" +
      "  var dateStr = today.getFullYear() + ('0' + (today.getMonth() + 1)).slice(-2) + ('0' + today.getDate()).slice(-2);" +
      "  link.setAttribute('download', targetName + '_클레임내역_' + dateStr + '.csv');" +
      "  link.style.visibility = 'hidden';" +
      "  document.body.appendChild(link);" +
      "  link.click();" +
      "  document.body.removeChild(link);" +
      "  showToast('📥 엑셀 파일이 다운로드되었습니다.');" +
      "}" +

      "var startX, startWidth, currentTh;" +
      "window.onload = function() {" +
      "  var resizers = document.querySelectorAll('.resizer');" +
      "  for (var i = 0; i < resizers.length; i++) {" +
      "    resizers[i].addEventListener('mousedown', function(e) {" +
      "      currentTh = this.parentElement;" +
      "      startX = e.pageX;" +
      "      startWidth = currentTh.offsetWidth;" +
      "      document.addEventListener('mousemove', mouseMoveHandler);" +
      "      document.addEventListener('mouseup', mouseUpHandler);" +
      "      this.style.backgroundColor = '#2980b9';" +
      "      e.stopPropagation(); e.preventDefault();" +
      "    });" +
      "  }" +

      "  var ths = document.querySelectorAll('#claimTable th');" +
      "  var dragSrcIdx = -1;" +
      "  for (var k = 0; k < ths.length; k++) {" +
      "    ths[k].addEventListener('dragstart', function(e) {" +
      "      if (e.target.tagName === 'INPUT' || e.target.className.indexOf('resizer') > -1) { e.preventDefault(); return; }" +
      "      dragSrcIdx = Array.prototype.indexOf.call(this.parentNode.children, this);" +
      "      e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/html', this.innerHTML);" +
      "      this.style.opacity = '0.4';" +
      "    });" +
      "    ths[k].addEventListener('dragover', function(e) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; return false; });" +
      "    ths[k].addEventListener('dragenter', function(e) { this.classList.add('over'); });" +
      "    ths[k].addEventListener('dragleave', function(e) { this.classList.remove('over'); });" +
      "    ths[k].addEventListener('drop', function(e) {" +
      "      e.stopPropagation(); this.classList.remove('over');" +
      "      var dropTargetIdx = Array.prototype.indexOf.call(this.parentNode.children, this);" +
      "      if (dragSrcIdx !== dropTargetIdx && dragSrcIdx !== -1) {" +
      "        var table = document.getElementById('claimTable');" +
      "        for (var r = 0; r < table.rows.length; r++) {" +
      "          var moving = table.rows[r].children[dragSrcIdx];" +
      "          var target = table.rows[r].children[dropTargetIdx];" +
      "          if (dragSrcIdx < dropTargetIdx) { target.parentNode.insertBefore(moving, target.nextSibling); } " +
      "          else { target.parentNode.insertBefore(moving, target); }" +
      "        }" +
      "        updateLayoutFromDOM();" +
      "        var inputs = document.getElementsByClassName('col-filter');" +
      "        for (var f = 0; f < inputs.length; f++) {" +
      "          var pTh = inputs[f].closest('th');" +
      "          inputs[f].setAttribute('data-idx', Array.prototype.indexOf.call(pTh.parentNode.children, pTh));" +
      "        }" +
      "      }" +
      "      return false;" +
      "    });" +
      "    ths[k].addEventListener('dragend', function(e) {" +
      "      this.style.opacity = '1';" +
      "      var allTh = document.querySelectorAll('#claimTable th');" +
      "      for(var j=0; j<allTh.length; j++) allTh[j].classList.remove('over');" +
      "    });" +
      "  }" +

      "  if (document.getElementById('shrinkCheck').checked) {" +
      "    adjustFontSizes();" +
      "  }" +
      "  filterTableMulti();" +
      "};" +

      "function mouseMoveHandler(e) {" +
      "  if (currentTh) {" +
      "    var newWidth = startWidth + (e.pageX - startX);" +
      "    if (newWidth > 15) {" + 
      "      currentTh.style.width = newWidth + 'px';" +
      "      currentTh.style.minWidth = newWidth + 'px';" +
      "      currentTh.style.maxWidth = newWidth + 'px';" +
      "      currentTh.setAttribute('data-width', newWidth);" +
      "      var colIdx = Array.prototype.indexOf.call(currentTh.parentNode.children, currentTh);" +
      "      var tds = document.querySelectorAll('#claimTable tbody tr');" +
      "      tds.forEach(function(tr) {" +
      "        var td = tr.children[colIdx];" +
      "        if(td) { td.style.width = newWidth + 'px'; td.style.minWidth = newWidth + 'px'; td.style.maxWidth = newWidth + 'px'; }" +
      "      });" +
      "    }" +
      "  }" +
      "}" +

      "function mouseUpHandler(e) {" +
      "  if (currentTh) {" +
      "    currentTh.querySelector('.resizer').style.backgroundColor = 'transparent';" +
      "    updateLayoutFromDOM();" +
      "    currentTh = null;" +
      "    document.removeEventListener('mousemove', mouseMoveHandler);" +
      "    document.removeEventListener('mouseup', mouseUpHandler);" +
      "    adjustFontSizes();" + 
      "  }" +
      "}" +
      "</script>";

    html += "</div>";
    return HtmlService.createHtmlOutput(html).setTitle(targetName + " 뷰어");

  } catch (err) {
    return HtmlService.createHtmlOutput("<h3 style='color:red;'>❌ 오류 발생:</h3><p>" + err.toString() + "</p>");
  }
}

function getClaimTracker() {
  try {
    var raw = PropertiesService.getScriptProperties().getProperty("CLAIM_APPEARANCE_COUNT");
    return raw ? JSON.parse(raw) : {};
  } catch(e) {
    return {};
  }
}

function updateClaimTracker(activeRtnNumbers) {
  var tracker = getClaimTracker();
  var todayStr = Utilities.formatDate(new Date(), "Asia/Seoul", "yyyy-MM-dd");
  
  if (Array.isArray(activeRtnNumbers)) {
    activeRtnNumbers.forEach(function(rtn) {
      if (!rtn) return;
      rtn = String(rtn).trim();
      if (rtn === "" || rtn === "반품번호") return;
      
      if (tracker[rtn]) {
        if (tracker[rtn].lastDate !== todayStr) {
          tracker[rtn].count = (tracker[rtn].count || 1) + 1;
          tracker[rtn].lastDate = todayStr;
        }
      } else {
        tracker[rtn] = { count: 1, lastDate: todayStr };
      }
    });
  }
  
  try {
    PropertiesService.getScriptProperties().setProperty("CLAIM_APPEARANCE_COUNT", JSON.stringify(tracker));
  } catch(e) {}
  return tracker;
}

function saveUserLayoutApp(personName, layoutStr, isShrinkFit) {
  try {
    PropertiesService.getScriptProperties().setProperty("COLUMN_LAYOUT_" + personName, layoutStr);
    PropertiesService.getScriptProperties().setProperty("SHRINK_FIT_" + personName, isShrinkFit ? "Y" : "N");
    return "success";
  } catch(e) {
    throw new Error(e.toString());
  }
}

function formatPhoneNumber(val) {
  if (!val) return "";
  var str = String(val).replace(/[^0-9]/g, "");
  if (str.length === 9 && str.charAt(0) === '2') { str = "0" + str; }
  else if (str.length === 10 && str.charAt(0) === '1') { str = "0" + str; }
  if (str.length === 11) { return str.replace(/(\d{3})(\d{4})(\d{4})/, "$1-$2-$3"); }
  else if (str.length === 10) {
    if (str.indexOf("02") === 0) return str.replace(/(\d{2})(\d{4})(\d{4})/, "$1-$2-$3");
    return str.replace(/(\d{3})(\d{3})(\d{4})/, "$1-$2-$3");
  } else if (str.length === 9 && str.indexOf("02") === 0) {
    return str.replace(/(\d{2})(\d{3})(\d{4})/, "$1-$2-$3");
  }
  return String(val).trim();
}

function formatDateToYYYYMMDD(val) {
  if (!val) return "";
  if (val instanceof Date) return Utilities.formatDate(val, "Asia/Seoul", "yyyy-MM-dd");
  var str = String(val).trim();
  var match = str.match(/(\d{4})[-.\/]\s*(\d{1,2})[-.\/]\s*(\d{1,2})/);
  if (match) return match[1] + "-" + ("0" + match[2]).slice(-2) + "-" + ("0" + match[3]).slice(-2);
  return str;
}

function processAndFormatClaimData() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var baseSheet = ss.getSheetByName("기본");
  var claimSheet = ss.getSheetByName("클레임");
  if (!baseSheet) return {};

  var targetColumns = ["품목담당자명", "반품번호", "등록일시", "거래처코드", "거래처명", "반품전화번호", "품목코드", "품목명", "요청내역", "수량", "확인자명", "확인일시"];
  var columnWidths = {"품목담당자명": 80, "반품번호": 150, "등록일시": 75, "거래처코드": 70, "거래처명": 200, "반품전화번호": 100, "품목코드": 100, "품목명": 230, "요청내역": 400, "수량": 50, "확인자명": 150, "확인일시": 75};

  var claimValues = baseSheet.getDataRange().getValues();
  if (claimValues.length < 2) return {};

  var originalHeaders = claimValues[0].map(function(h) { return String(h).trim(); });
  var originalRows = claimValues.slice(1);
  var colIndexes = targetColumns.map(function(targetCol) { return originalHeaders.indexOf(targetCol); });
  var statusColIndex = originalHeaders.indexOf("접수여부");
  var progressColIndex = originalHeaders.indexOf("진행상태");
  var regDateIdxInTarget = targetColumns.indexOf("등록일시");
  var confirmDateIdxInTarget = targetColumns.indexOf("확인일시");
  var phoneIdxInTarget = targetColumns.indexOf("반품전화번호");
  var itemIdxInTarget = targetColumns.indexOf("품목명");
  var rtnIdxInTarget = targetColumns.indexOf("반품번호");

  var reorderedRows = originalRows.map(function(row) {
    return colIndexes.map(function(idx, colArrIdx) {
      if (idx !== -1 && idx < row.length) {
        var val = row[idx];
        if (colArrIdx === regDateIdxInTarget || colArrIdx === confirmDateIdxInTarget) return formatDateToYYYYMMDD(val);
        if (colArrIdx === phoneIdxInTarget) return formatPhoneNumber(val);
        return (val instanceof Date) ? Utilities.formatDate(val, "Asia/Seoul", "yyyy-MM-dd") : String(val).trim();
      }
      return "";
    });
  });

  var listSheet = ss.getSheetByName("발송자리스트");
  var lastRowList = listSheet ? listSheet.getLastRow() : 0;
  var targetNames = [];
  if (lastRowList > 0) {
    var listData = listSheet.getRange(1, 1, lastRowList, 1).getValues();
    listData.forEach(function(row) {
      var n = String(row[0]).trim();
      if (n && n !== "이름" && n !== "담당자") targetNames.push(n);
    });
  }

  var filteredReorderedRows = reorderedRows.filter(function(r, idx) {
    var origRow = originalRows[idx];
    var targetPerson = String(r[0]).trim();
    var rawStatus = statusColIndex !== -1 ? String(origRow[statusColIndex]).replace(/\s+/g, "").toUpperCase() : "";
    var rawProgress = progressColIndex !== -1 ? String(origRow[progressColIndex]).trim() : "";
    var isProgressMatched = (progressColIndex === -1) || (rawProgress === "확인");
    return targetNames.indexOf(targetPerson) !== -1 && rawStatus !== "Y" && isProgressMatched;
  });

  filteredReorderedRows.sort(function(a, b) { 
    var nameA = String(a[0]).trim();
    var nameB = String(b[0]).trim();
    var cmpName = nameA.localeCompare(nameB, 'ko');
    if (cmpName === 0 && itemIdxInTarget !== -1) {
      var itemA = String(a[itemIdxInTarget]).trim();
      var itemB = String(b[itemIdxInTarget]).trim();
      return itemA.localeCompare(itemB, 'ko');
    }
    return cmpName;
  });

  var activeRtnNumbers = filteredReorderedRows.map(function(r) {
    return (rtnIdxInTarget !== -1) ? String(r[rtnIdxInTarget]).trim() : "";
  });
  var tracker = updateClaimTracker(activeRtnNumbers);
  
  claimSheet.clear();

  var finalTableData = [targetColumns].concat(filteredReorderedRows);
  var totalRows = finalTableData.length;
  var range = claimSheet.getRange(1, 1, totalRows, targetColumns.length);
  
  range.setNumberFormat("@");
  range.setValues(finalTableData);

  var maxCols = claimSheet.getMaxColumns();
  if (maxCols > targetColumns.length) claimSheet.deleteColumns(targetColumns.length + 1, maxCols - targetColumns.length);

  var qtyColIdx = targetColumns.indexOf("수량") + 1;
  if (totalRows > 1 && qtyColIdx > 0) claimSheet.getRange(2, qtyColIdx, totalRows - 1, 1).setNumberFormat("#,##0");

  range.setBorder(true, true, true, true, true, true, "#000000", SpreadsheetApp.BorderStyle.SOLID);
  claimSheet.getRange(1, 1, 1, targetColumns.length).setFontWeight("bold").setHorizontalAlignment("center");
  range.setWrapStrategy(SpreadsheetApp.WrapStrategy.WRAP);

  for (var i = 0; i < filteredReorderedRows.length; i++) {
    var rtnVal = (rtnIdxInTarget !== -1) ? String(filteredReorderedRows[i][rtnIdxInTarget]).trim() : "";
    var info = tracker[rtnVal];
    var c = info ? (info.count || 1) : 1;
    var rowRange = claimSheet.getRange(i + 2, 1, 1, targetColumns.length);
    if (c === 2) {
      rowRange.setFontColor("#d68910").setFontWeight("bold"); 
    } else if (c >= 3) {
      rowRange.setFontColor("#e74c3c").setFontWeight("bold"); 
    } else {
      rowRange.setFontColor("#000000").setFontWeight("normal");
    }
  }

  SpreadsheetApp.flush();

  for (var col = 1; col <= targetColumns.length; col++) {
    var colName = targetColumns[col - 1];
    var specifiedWidth = columnWidths[colName];
    if (specifiedWidth) claimSheet.setColumnWidth(col, specifiedWidth);
  }
  return {};
}

function sendTotalClaimEmail(recipientEmails) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var claimSheet = ss.getSheetByName("클레임");
  var data = claimSheet.getDataRange().getDisplayValues();
  if (data.length < 2) return; 

  var headers = data[0];
  var rows = data.slice(1);
  var todayStr = Utilities.formatDate(new Date(), "Asia/Seoul", "yyyy-MM-dd");
  var subject = "미접수 클레임 전달건 (" + rows.length + "건) - " + todayStr;

  var rawUrl = ScriptApp.getService().getUrl();
  var webAppUrl = rawUrl ? rawUrl.replace(/\/u\/\d+\//, "/") : "";

  var nameIndex = headers.indexOf("품목담당자명");
  if (nameIndex === -1) nameIndex = 0;
  var rtnIndex = headers.indexOf("반품번호");
  var tracker = getClaimTracker();

  var htmlBody = "<div style='font-family: \"Malgun Gothic\", Arial, sans-serif; color: #333; overflow-x: auto;'>" +
    "<h3>안녕하세요. 금일 OMS 미접수 클레임 공유드립니다.</h3>" +
    "<p style='color: #2980b9;'>※ 아래 표에서 <b>담당자 이름(파란색 링크)</b>을 클릭하시면, 해당 담당자의 클레임만 모아서 볼 수 있습니다.</p>" +
    "<table style='border-collapse: collapse; width: max-content; font-size: 12px; text-align: center;' border='1'>" +
    "<thead style='background-color: #f2f2f2; font-weight: bold;'><tr>";

  headers.forEach(function(h) {
    htmlBody += "<th style='padding: 6px 12px; border: 1px solid #ccc; white-space: nowrap;'>" + h + "</th>";
  });
  htmlBody += "</tr></thead><tbody>";

  var seenNames = {};

  rows.forEach(function(row) {
    var rtnVal = (rtnIndex !== -1 && row[rtnIndex]) ? String(row[rtnIndex]).trim() : "";
    var rtnInfo = tracker[rtnVal];
    var rtnCount = rtnInfo ? (rtnInfo.count || 1) : 1;

    var colorStyle = "";
    if (rtnCount === 2) {
      colorStyle = "color: #d68910; font-weight: bold;";
    } else if (rtnCount >= 3) {
      colorStyle = "color: #e74c3c; font-weight: bold;";
    }

    htmlBody += "<tr style='" + colorStyle + "'>";
    row.forEach(function(cell, colIdx) {
      var cleanCell = String(cell).replace(/^'/, '');
      var headerName = headers[colIdx];
      var alignLeft = (headerName === "요청내역" || headerName === "품목명" || headerName === "거래처명");
      var alignStyle = alignLeft ? "text-align: left;" : "text-align: center;";

      if (colIdx === nameIndex && cleanCell !== "") {
        if (!seenNames[cleanCell]) {
          var linkUrl = webAppUrl + "?name=" + encodeURIComponent(cleanCell);
          htmlBody += "<td style='padding: 6px 12px; border: 1px solid #ccc; white-space: nowrap; " + alignStyle + " " + colorStyle + "'>" +
                      "<a href='" + linkUrl + "' style='color: #0056b3; font-weight: bold; text-decoration: underline;' target='_blank'>" + cleanCell + "</a>" +
                      "</td>";
          seenNames[cleanCell] = true;
        } else {
          htmlBody += "<td style='padding: 6px 12px; border: 1px solid #ccc; white-space: nowrap; " + alignStyle + " " + colorStyle + "'>" + cleanCell + "</td>";
        }
      } else {
        htmlBody += "<td style='padding: 6px 12px; border: 1px solid #ccc; white-space: nowrap; " + alignStyle + " " + colorStyle + "'>" + cleanCell + "</td>";
      }
    });
    htmlBody += "</tr>";
  });

  htmlBody += "</tbody></table><br/>감사합니다.</div>";

  GmailApp.sendEmail(recipientEmails, subject, "", {
    htmlBody: htmlBody
  });
  Logger.log("✅ 메일용 복사 사진 하이퍼링크 유지 수정 완료");
}
